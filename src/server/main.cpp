// acm-core: the HTTP face of the control service. It only translates HTTP into
// ControlService calls and back; every rule lives in the core library.
//
//   POST /internal/v1/tools/{tool}   agent commands (Bearer session credential)
//   POST /internal/v1/enroll         a bridge registers the credential it generated
//   /api/v1/...                      operator API (X-ACM-Admin-Token)
//   GET  /api/v1/events              committed events as JSON, or as an SSE
//                                    stream when Accept is text/event-stream
#include "core/control_service.hpp"
#include "core/crypto.hpp"

#include <drogon/drogon.h>

#include <charconv>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

namespace {

using acm::json;
using Callback = std::function<void(const drogon::HttpResponsePtr&)>;

constexpr const char* kVersion = "0.4.0";

struct Options {
    std::filesystem::path data_dir;
    std::string host = "127.0.0.1";
    std::uint16_t port = 8766;
    std::uint16_t mcp_port = 0;    // the gateway's port, when a gateway started this process
    std::filesystem::path ui_dir;  // built operator console; empty when not available
    // How clients reach this installation; shown by the console when it prints
    // ready-to-paste client configuration. Supplied by the gateway that owns them.
    json service_info = json::object();
};

// Arguments arrive as UTF-16 (wmain) so a data directory with non-ASCII
// characters is not mangled by the process ANSI code page.
Options parse_options(int argc, wchar_t** argv) {
    Options options;
    const auto narrow = [](const std::wstring& text) { return std::filesystem::path(text).string(); };
    for (int index = 1; index < argc; ++index) {
        const std::wstring name = argv[index];
        if (index + 1 >= argc) {
            throw std::runtime_error("missing value for " + narrow(name));
        }
        const std::wstring value = argv[++index];
        if (name == L"--data-dir") {
            options.data_dir = std::filesystem::path(value);
        } else if (name == L"--host") {
            options.host = narrow(value);
        } else if (name == L"--port") {
            options.port = static_cast<std::uint16_t>(std::stoi(value));
        } else if (name == L"--mcp-port") {
            options.mcp_port = static_cast<std::uint16_t>(std::stoi(value));
        } else if (name == L"--ui-dir") {
            options.ui_dir = std::filesystem::path(value);
        } else if (name == L"--mcp-url" || name == L"--stdio-entry" || name == L"--node-path") {
            const auto utf8 = std::filesystem::path(value).u8string();
            const char* key = name == L"--mcp-url" ? "mcp_url" : name == L"--stdio-entry" ? "stdio_entry" : "node_path";
            options.service_info[key] = std::string(utf8.begin(), utf8.end());
        } else {
            throw std::runtime_error("unknown option " + narrow(name));
        }
    }
    if (options.data_dir.empty()) {
        throw std::runtime_error("--data-dir is required");
    }
    // The command line a client must launch to reach THIS instance. The bridge
    // has defaults of its own, so the data directory and ports are always spelled
    // out; otherwise a second instance would hand out configuration that points
    // at the default one.
    if (options.service_info.contains("stdio_entry")) {
        const auto dir = std::filesystem::absolute(options.data_dir).lexically_normal().u8string();
        json arguments = json::array();
        arguments.push_back(options.service_info.at("stdio_entry"));
        arguments.push_back("--data-dir");
        arguments.push_back(std::string(dir.begin(), dir.end()));
        arguments.push_back("--core-port");
        arguments.push_back(std::to_string(options.port));
        if (options.mcp_port != 0) {
            arguments.push_back("--mcp-port");
            arguments.push_back(std::to_string(options.mcp_port));
        }
        options.service_info["stdio_args"] = std::move(arguments);
    }
    return options;
}

// The operator credential lives beside the database and is created on first start.
std::string load_or_create_admin_token(const std::filesystem::path& data_dir) {
    const auto file = data_dir / "admin-token.txt";
    if (std::filesystem::exists(file)) {
        std::ifstream input(file);
        std::string token;
        std::getline(input, token);
        if (!token.empty()) {
            return token;
        }
    }
    const std::string token = "acmadmin_" + acm::random_hex(24);
    std::ofstream(file, std::ios::trunc) << token << "\n";
    return token;
}

int http_status(const std::string& code) {
    if (code == "UNAUTHENTICATED" || code == "SESSION_REVOKED" || code == "ADMIN_REQUIRED") {
        return 401;
    }
    if (code == "NOT_PAIRED" || code == "PAIRING_EXPIRED" || code == "NOT_MEMBER" || code == "READ_DENIED" ||
        code == "WRITE_DENIED" || code == "CROSS_PROJECT" || code == "NOT_RECIPIENT") {
        return 403;
    }
    if (code == "NOT_FOUND" || code == "UNKNOWN_TOOL" || code == "UNKNOWN_OPERATION") {
        return 404;
    }
    if (code == "VERSION_CONFLICT" || code == "IDEMPOTENCY_CONFLICT" || code == "ALREADY_EXISTS" ||
        code == "CONVERSATION_ARCHIVED" || code == "NAME_TAKEN") {
        return 409;
    }
    if (code == "INVALID_ARGUMENT" || code == "ACTION_NOT_ALLOWED") {
        return 400;
    }
    if (code == "RATE_LIMITED") {
        return 429;
    }
    return 422;
}

drogon::HttpResponsePtr json_response(int status, const json& body) {
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(static_cast<drogon::HttpStatusCode>(status));
    response->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    response->setBody(body.dump());
    return response;
}

drogon::HttpResponsePtr error_response(const acm::ControlError& error) {
    return json_response(http_status(error.code()),
                         {{"ok", false},
                          {"error", {{"code", error.code()}, {"message", error.what()}, {"details", error.details()}}}});
}

std::vector<std::string> split_path(const std::string& path) {
    std::vector<std::string> segments;
    std::size_t start = 0;
    while (start < path.size()) {
        const std::size_t end = std::min(path.find('/', start), path.size());
        if (end > start) {
            segments.push_back(path.substr(start, end - start));
        }
        start = end + 1;
    }
    return segments;
}

json parse_body(const drogon::HttpRequestPtr& request) {
    const auto body = request->getBody();
    if (body.empty()) {
        return json::object();
    }
    json parsed = json::parse(body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        acm::fail("INVALID_ARGUMENT", "the request body must be a JSON object");
    }
    return parsed;
}

std::string bearer_token(const drogon::HttpRequestPtr& request) {
    const std::string& header = request->getHeader("authorization");
    constexpr std::string_view prefix = "Bearer ";
    return header.starts_with(prefix) ? header.substr(prefix.size()) : std::string();
}

std::int64_t integer_parameter(const drogon::HttpRequestPtr& request, const std::string& name, std::int64_t fallback) {
    const std::string& text = request->getParameter(name);
    if (text.empty()) {
        return fallback;
    }
    std::int64_t value = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec != std::errc() || result.ptr != text.data() + text.size() || value < 0) {
        acm::fail("INVALID_ARGUMENT", name + " must be a non-negative integer");
    }
    return value;
}

// Copies paging query parameters into a command argument object.
json paging_arguments(const drogon::HttpRequestPtr& request) {
    json args = json::object();
    for (const char* name : {"after_seq", "limit"}) {
        if (!request->getParameter(name).empty()) {
            args[name] = integer_parameter(request, name, 0);
        }
    }
    return args;
}

// One SSE connection: replays committed events after `cursor`, then follows.
struct EventStream {
    drogon::ResponseStreamPtr stream;
    std::int64_t cursor = 0;
    int idle_ticks = 0;
    trantor::TimerId timer = 0;
};

constexpr double kStreamTickSeconds = 0.2;
constexpr int kHeartbeatTicks = 75;  // 15 seconds of silence

bool pump_events(EventStream& state, acm::ControlService& service) {
    const json batch = service.events_after(state.cursor, 200);
    for (const auto& event : batch.at("events")) {
        const std::int64_t id = event.at("event_id").get<std::int64_t>();
        const std::string frame = "id: " + std::to_string(id) + "\nevent: " +
                                  event.at("event_type").get<std::string>() + "\ndata: " + event.dump() + "\n\n";
        if (!state.stream->send(frame)) {
            return false;
        }
        state.cursor = id;
        state.idle_ticks = 0;
    }
    if (++state.idle_ticks >= kHeartbeatTicks) {
        state.idle_ticks = 0;
        return state.stream->send(": heartbeat\n\n");
    }
    return true;
}

drogon::HttpResponsePtr event_stream_response(acm::ControlService& service, std::int64_t after) {
    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [&service, after](drogon::ResponseStreamPtr stream) {
            auto state = std::make_shared<EventStream>();
            state->stream = std::move(stream);
            state->cursor = after;
            auto* loop = trantor::EventLoop::getEventLoopOfCurrentThread();
            if (!pump_events(*state, service)) {
                state->stream->close();
                return;
            }
            state->timer = loop->runEvery(kStreamTickSeconds, [state, &service, loop] {
                if (!pump_events(*state, service)) {
                    loop->invalidateTimer(state->timer);
                    state->stream->close();
                }
            });
        },
        true);
    response->setContentTypeString("text/event-stream; charset=utf-8");
    response->addHeader("Cache-Control", "no-cache");
    return response;
}

class Router {
public:
    Router(acm::ControlService& service, std::string admin_token, std::filesystem::path ui_dir, json service_info,
           std::filesystem::path data_dir)
        : service_(service),
          admin_token_(std::move(admin_token)),
          ui_dir_(std::move(ui_dir)),
          service_info_(std::move(service_info)),
          avatar_dir_(std::move(data_dir) / "avatars") {}

    void handle(const drogon::HttpRequestPtr& request, Callback&& callback) {
        try {
            callback(route(request));
        } catch (const acm::ControlError& error) {
            callback(error_response(error));
        } catch (const std::exception& error) {
            // Unexpected failures are reported with their cause; nothing is swallowed.
            std::fprintf(stderr, "[ERROR] %s %s: %s\n", request->getMethodString(), request->path().c_str(),
                         error.what());
            callback(json_response(500, {{"ok", false},
                                         {"error", {{"code", "INTERNAL"}, {"message", error.what()}}}}));
        }
    }

private:
    drogon::HttpResponsePtr ok(const json& result) { return json_response(200, {{"ok", true}, {"result", result}}); }

    // Which kind of picture these bytes are, by how they begin; empty when none we take.
    static std::string picture_kind(std::string_view bytes) {
        const auto starts = [&](std::string_view head) { return bytes.substr(0, head.size()) == head; };
        if (starts("\x89PNG\r\n\x1a\n")) {
            return "png";
        }
        if (starts("\xff\xd8\xff")) {
            return "jpg";
        }
        if (starts("GIF87a") || starts("GIF89a")) {
            return "gif";
        }
        if (bytes.size() > 12 && starts("RIFF") && bytes.substr(8, 4) == "WEBP") {
            return "webp";
        }
        return {};
    }

    json store_avatar(const std::string& slot, std::string_view bytes) {
        static constexpr std::size_t kLimit = 16 * 1024 * 1024;
        const std::string kind = picture_kind(bytes);
        if (kind.empty()) {
            acm::fail("INVALID_ARGUMENT", "an avatar is a PNG, JPEG, GIF or WebP picture");
        }
        if (bytes.size() > kLimit) {
            acm::fail("INVALID_ARGUMENT", "an avatar may be 16 MB at most");
        }
        // Checks the name of the slot before anything is written under it.
        const json before = service_.admin("avatar", slot, json::object());
        std::error_code error;
        std::filesystem::create_directories(avatar_dir_, error);
        if (before.at("custom").get<bool>()) {
            std::filesystem::remove(avatar_dir_ / (slot + "." + before.at("kind").get<std::string>()), error);
        }
        const auto file = avatar_dir_ / (slot + "." + kind);
        std::ofstream out(file, std::ios::binary | std::ios::trunc);
        out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        out.close();
        if (!out) {
            acm::fail("INTERNAL", "the picture could not be written to the data directory");
        }
        return service_.admin("set_avatar", slot, {{"kind", kind}});
    }

    drogon::HttpResponsePtr custom_avatar(const std::string& slot) {
        const json known = service_.admin("avatar", slot, json::object());
        if (!known.at("custom").get<bool>()) {
            acm::fail("NOT_FOUND", "no such avatar");
        }
        const auto file = (avatar_dir_ / (slot + "." + known.at("kind").get<std::string>())).u8string();
        std::error_code error;
        if (!std::filesystem::is_regular_file(std::filesystem::path(file), error)) {
            acm::fail("NOT_FOUND", "no such avatar");
        }
        auto response = drogon::HttpResponse::newFileResponse(std::string(file.begin(), file.end()));
        // Its address carries its version (?v=...), so a copy never goes stale.
        response->addHeader("Cache-Control", "public, max-age=31536000, immutable");
        return response;
    }

    // Serves the built operator console. The files are public static assets; every
    // piece of data they show is fetched from /api/v1 with the operator credential.
    // Unknown paths fall back to index.html so client-side routes survive a reload.
    drogon::HttpResponsePtr console_file(const std::vector<std::string>& segments) {
        std::error_code error;
        const auto root = std::filesystem::weakly_canonical(ui_dir_, error);
        if (ui_dir_.empty() || error || !std::filesystem::is_regular_file(root / "index.html", error)) {
            acm::fail("NOT_FOUND", "the operator console is not built; run: npm run build:ui");
        }
        auto target = root;
        for (const auto& segment : segments) {
            if (segment == ".." || segment.find_first_of("\\:") != std::string::npos) {
                acm::fail("NOT_FOUND", "no such file");
            }
            target /= std::filesystem::path(std::u8string(segment.begin(), segment.end()));
        }
        const bool is_asset = !segments.empty() && std::filesystem::is_regular_file(target, error);
        const auto file = (is_asset ? target : root / "index.html").u8string();
        auto response = drogon::HttpResponse::newFileResponse(std::string(file.begin(), file.end()));
        // Hashed assets may be cached; the entry document must always be revalidated. The
        // avatars are full-size pictures that every row of a timeline shows: kept for a day.
        const bool hashed = is_asset && segments.front() == "assets";
        const bool avatar = is_asset && segments.front() == "avatars";
        response->addHeader("Cache-Control", hashed ? "public, max-age=31536000, immutable"
                                             : avatar ? "public, max-age=86400"
                                                      : "no-cache");
        return response;
    }

    void require_admin(const drogon::HttpRequestPtr& request) {
        if (request->getHeader("x-acm-admin-token") != admin_token_) {
            acm::fail("ADMIN_REQUIRED", "this endpoint needs the operator credential in X-ACM-Admin-Token");
        }
    }

    drogon::HttpResponsePtr route(const drogon::HttpRequestPtr& request) {
        const auto method = request->method();
        const auto path = split_path(request->path());
        const auto is = [&](std::size_t index, std::string_view text) {
            return path.size() > index && path[index] == text;
        };

        if (path.size() == 1 && is(0, "healthz") && method == drogon::Get) {
            return ok({{"status", "ok"}, {"version", kVersion}, {"schema_version", service_.schema_version()}});
        }
        if (path.size() == 4 && is(0, "internal") && is(1, "v1") && is(2, "tools") && method == drogon::Post) {
            // What the entry point knows about the conversation the call comes from.
            json context = json::object();
            for (const auto& [header, field] : {std::pair{"x-acm-client", "client"}, std::pair{"x-acm-client-session", "client_session"}}) {
                if (const std::string& value = request->getHeader(header); !value.empty()) {
                    context[field] = value;
                }
            }
            return ok(service_.call_tool(bearer_token(request), path[3], parse_body(request), context));
        }
        if (path.size() == 3 && is(0, "internal") && is(1, "v1") && is(2, "enroll") && method == drogon::Post) {
            return ok(service_.enroll(bearer_token(request), parse_body(request)));
        }
        if (path.size() == 3 && is(0, "internal") && is(1, "v1") && is(2, "hook") && method == drogon::Post) {
            return ok(service_.hook(bearer_token(request), parse_body(request)));
        }
        if (path.size() == 3 && is(0, "internal") && is(1, "v1") && is(2, "shutdown") && method == drogon::Post) {
            require_admin(request);
            drogon::app().getLoop()->runAfter(0.2, [] { drogon::app().quit(); });
            return ok({{"stopping", true}});
        }
        // A picture the operator put in place of a built-in avatar. Public like the
        // console's own files: it is shown by an <img>, which cannot carry a credential.
        if (method == drogon::Get && path.size() == 3 && is(0, "avatars") && is(1, "custom")) {
            return custom_avatar(path[2]);
        }
        if (method == drogon::Get && !is(0, "api") && !is(0, "internal")) {
            return console_file(path);
        }
        if (!(path.size() >= 3 && is(0, "api") && is(1, "v1"))) {
            acm::fail("NOT_FOUND", "no such endpoint");
        }
        require_admin(request);

        const std::string& resource = path[2];
        if (path.size() == 3) {
            if (resource == "bootstrap" && method == drogon::Get) {
                json state = service_.admin("bootstrap", "", json::object());
                state["service"] = service_info_;
                state["service"]["version"] = kVersion;
                return ok(state);
            }
            if (resource == "events" && method == drogon::Get) {
                const std::string& resume = request->getHeader("last-event-id");
                std::int64_t after = integer_parameter(request, "after", 0);
                if (!resume.empty()) {
                    std::from_chars(resume.data(), resume.data() + resume.size(), after);
                }
                if (request->getHeader("accept").find("text/event-stream") != std::string::npos) {
                    return event_stream_response(service_, after);
                }
                return ok(service_.events_after(after, std::min<std::int64_t>(
                                                           integer_parameter(request, "limit", 200), 1000)));
            }
            // Counts for the console's overview charts.
            if (resource == "stats" && method == drogon::Get) {
                json args = json::object();
                if (!request->getParameter("days").empty()) {
                    args["days"] = integer_parameter(request, "days", 7);
                }
                return ok(service_.admin("stats", "", args));
            }
            if (resource == "sessions" && method == drogon::Get) {
                return ok(service_.admin("list_sessions", "", json::object()));
            }
            if (resource == "remote-access" && method == drogon::Put) {
                return ok(service_.admin("set_remote_access", "", parse_body(request)));
            }
            if (resource == "settings" && method == drogon::Put) {
                return ok(service_.admin("set_settings", "", parse_body(request)));
            }
            if (method == drogon::Post) {
                static const std::vector<std::pair<std::string_view, std::string_view>> creators = {
                    {"projects", "create_project"},
                    {"agents", "create_agent"},
                    {"pairings", "create_pairing"},
                    {"conversations", "create_conversation"}};
                for (const auto& [name, operation] : creators) {
                    if (resource == name) {
                        return ok(service_.admin(operation, "", parse_body(request)));
                    }
                }
            }
        }
        if (path.size() == 5 && method == drogon::Post) {
            if (resource == "pairings" && is(4, "approve")) {
                return ok(service_.admin("approve_pairing", path[3], json::object()));
            }
            if (resource == "sessions" && is(4, "revoke")) {
                return ok(service_.admin("revoke_session", path[3], json::object()));
            }
            if (resource == "bot-requests" && (is(4, "approve") || is(4, "reject"))) {
                return ok(service_.admin(is(4, "approve") ? "approve_bot_request" : "reject_bot_request", path[3],
                                         json::object()));
            }
            if (resource == "proposals" && (is(4, "approve") || is(4, "reject"))) {
                return ok(service_.admin(is(4, "approve") ? "approve_proposal" : "reject_proposal", path[3],
                                         json::object()));
            }
        }
        if (resource == "conversations" && path.size() == 4 && method == drogon::Get) {
            return ok(service_.admin("get_conversation", path[3], json::object()));
        }
        // Keeping the list tidy: rename or archive, clear the messages, delete for good.
        if (resource == "conversations" && path.size() == 4 && method == drogon::Put) {
            return ok(service_.admin("update_conversation", path[3], parse_body(request)));
        }
        if (resource == "conversations" && path.size() == 4 && method == drogon::Delete) {
            return ok(service_.admin("delete_conversation", path[3], json::object()));
        }
        if (resource == "conversations" && path.size() == 5 && is(4, "clear") && method == drogon::Post) {
            return ok(service_.admin("clear_conversation", path[3], parse_body(request)));
        }
        // Wake hooks: the operator's settings per session, and the gateway's claim/report pair.
        if (resource == "sessions" && path.size() == 5 && is(4, "wake-hook") && method == drogon::Put) {
            return ok(service_.admin("set_wake_hook", path[3], parse_body(request)));
        }
        if (resource == "sessions" && path.size() == 6 && is(4, "wake-hook") && method == drogon::Post) {
            if (is(5, "test")) {
                return ok(service_.admin("test_wake_hook", path[3], json::object()));
            }
            if (is(5, "remove")) {
                return ok(service_.admin("remove_wake_hook", path[3], json::object()));
            }
        }
        // install is the operator's; config and report are for the gateway only and the tunnel proxy does not forward them.
        if (resource == "remote-access" && path.size() == 4 && method == drogon::Post) {
            if (is(3, "install")) {
                return ok(service_.admin("request_remote_install", "", json::object()));
            }
            if (is(3, "config")) {
                return ok(service_.admin("remote_config", "", json::object()));
            }
            if (is(3, "report")) {
                return ok(service_.admin("remote_report", "", parse_body(request)));
            }
        }
        // Urgent deliveries the gateway carries out by starting a client's command line.
        if (resource == "delivery" && path.size() == 4 && method == drogon::Post) {
            if (is(3, "claim")) {
                return ok(service_.admin("delivery_claim", "", parse_body(request)));
            }
            if (is(3, "report")) {
                return ok(service_.admin("delivery_report", "", parse_body(request)));
            }
            // A client has used up its quota, or has it again.
            // A command-line turn the gateway started is over.
            if (is(3, "ended")) {
                return ok(service_.admin("delivery_ended", "", parse_body(request)));
            }
            if (is(3, "limit")) {
                return ok(service_.admin("delivery_limit", "", parse_body(request)));
            }
        }
        if (resource == "wake" && path.size() == 4 && method == drogon::Post) {
            if (is(3, "claim")) {
                return ok(service_.admin("wake_claim", "", json::object()));
            }
            if (is(3, "report")) {
                return ok(service_.admin("wake_report", "", parse_body(request)));
            }
        }
        if (resource == "sessions" && path.size() == 4 && method == drogon::Put) {
            return ok(service_.admin("set_session", path[3], parse_body(request)));
        }
        if (resource == "agents" && path.size() == 4 && method == drogon::Put) {
            return ok(service_.admin("update_agent", path[3], parse_body(request)));
        }
        // The request body is the picture itself, as the browser read it from the file: unchanged.
        if (resource == "avatars" && path.size() == 4 && method == drogon::Put) {
            return ok(store_avatar(path[3], request->getBody()));
        }
        if (resource == "avatars" && path.size() == 4 && method == drogon::Delete) {
            const json before = service_.admin("avatar", path[3], json::object());
            if (before.at("custom").get<bool>()) {
                std::error_code ignored;
                std::filesystem::remove(avatar_dir_ / (path[3] + "." + before.at("kind").get<std::string>()), ignored);
            }
            return ok(service_.admin("remove_avatar", path[3], json::object()));
        }
        if (resource == "windows" && path.size() == 4 && method == drogon::Put) {
            return ok(service_.admin("rename_window", path[3], parse_body(request)));
        }
        // What compacting did to a conversation so far.
        if (resource == "conversations" && path.size() == 5 && is(4, "compactions") && method == drogon::Get) {
            return ok(service_.admin("compactions", path[3], json::object()));
        }
        // Every digest a conversation was given, and putting one of them back in use.
        if (resource == "conversations" && path.size() == 5 && is(4, "digests") && method == drogon::Get) {
            return ok(service_.admin("digests", path[3], json::object()));
        }
        if (resource == "conversations" && path.size() == 5 && is(4, "digest") && method == drogon::Put) {
            return ok(service_.admin("use_digest", path[3], parse_body(request)));
        }
        // The operator compacts a conversation: digest, messages to keep, messages to drop.
        if (resource == "conversations" && path.size() == 5 && is(4, "compact") && method == drogon::Post) {
            return ok(service_.admin("compact_conversation", path[3], parse_body(request)));
        }
        // Conversations the gateway found on a client's own record.
        if (resource == "windows" && path.size() == 4 && is(3, "import") && method == drogon::Post) {
            return ok(service_.admin("import_windows", "", parse_body(request)));
        }
        if (resource == "tasks" && path.size() == 4 && method == drogon::Put) {
            return ok(service_.admin("update_task", path[3], parse_body(request)));
        }
        if (resource == "conversations" && path.size() == 5) {
            if (is(4, "goal") && method == drogon::Put) {
                return ok(service_.admin("set_goal", path[3], parse_body(request)));
            }
            if (is(4, "tasks") && method == drogon::Get) {
                return ok(service_.admin("list_tasks", path[3], json::object()));
            }
            if (is(4, "tasks") && method == drogon::Post) {
                return ok(service_.admin("create_task", path[3], parse_body(request)));
            }
            if (is(4, "members") && method == drogon::Put) {
                return ok(service_.admin("set_members", path[3], parse_body(request)));
            }
            if (is(4, "messages") && method == drogon::Get) {
                return ok(service_.admin("read_messages", path[3], paging_arguments(request)));
            }
            if (is(4, "messages") && method == drogon::Post) {
                return ok(service_.admin("send_message", path[3], parse_body(request)));
            }
            if (is(4, "artifacts") && method == drogon::Get) {
                return ok(service_.admin("list_artifacts", path[3], json::object()));
            }
        }
        acm::fail("NOT_FOUND", "no such endpoint");
    }

    acm::ControlService& service_;
    std::string admin_token_;
    std::filesystem::path ui_dir_;
    json service_info_;
    // Where the avatars the operator chose are kept: <data>/avatars/<slot>.<kind>.
    std::filesystem::path avatar_dir_;
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const Options options = parse_options(argc, argv);
        std::filesystem::create_directories(options.data_dir);
        acm::ControlService service(options.data_dir);
        Router router(service, load_or_create_admin_token(options.data_dir), options.ui_dir, options.service_info,
                      options.data_dir);

        drogon::app().registerHandlerViaRegex(
            "/.*",
            [&router](const drogon::HttpRequestPtr& request, Callback&& callback) {
                router.handle(request, std::move(callback));
            },
            {drogon::Get, drogon::Post, drogon::Put, drogon::Delete});
        drogon::app()
            .setLogLevel(trantor::Logger::kWarn)
            .setThreadNum(2)
            .setIdleConnectionTimeout(0)
            // An avatar is uploaded as it is; nothing else the console sends is large.
            .setClientMaxBodySize(20 * 1024 * 1024)
            .setClientMaxMemoryBodySize(20 * 1024 * 1024)
            .addListener(options.host, options.port);
        std::printf("[OK] acm-core %s listening on http://%s:%u schema=%d\n", kVersion, options.host.c_str(),
                    static_cast<unsigned>(options.port), service.schema_version());
        std::fflush(stdout);
        drogon::app().run();
        std::printf("[OK] acm-core stopped\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "[ERROR] acm-core failed: %s\n", error.what());
        return 1;
    }
}
