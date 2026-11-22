#include "control_service.hpp"

#include "settings.hpp"

#include <array>
#include <algorithm>
#include <cctype>
#include <format>

namespace acm {

ControlService::ControlService(const std::filesystem::path& data_dir, Clock clock)
    : database_(data_dir / "acm.db"),
      events_(database_, clock),
      identity_(database_, events_, clock),
      conversations_(database_, events_, clock),
      messages_(database_, events_, conversations_, clock),
      progress_(database_, conversations_, messages_, clock),
      board_(database_, events_, conversations_, clock),
      bots_(database_, events_, clock),
      wake_(database_, events_, clock),
      delivery_(database_, events_, clock),
      windows_(database_, events_, clock),
      clock_(clock) {
    identity_.expire_stale_pairings();
    // Whatever tunnel a previous run had is gone with that run.
    store_text_setting(database_, "remote_state", "stopped");
    erase_setting(database_, "remote_url");
    erase_setting(database_, "remote_detail");
}

const std::vector<std::string>& ControlService::agent_tools() {
    static const std::vector<std::string> names = {
        "get_session",      "request_pairing",  "check_in",         "list_conversations",
        "get_conversation", "read_messages",    "send_message",     "forward_message",
        "get_inbox",        "acknowledge_message", "list_tasks",    "create_task",
        "update_task",      "propose_conversation", "report_progress", "publish_artifact",
        "get_artifact",     "direct_message",   "bot_request",      "bot_requests",
        "bot_pull",         "bot_respond",      "name_window",      "compact_conversation"};
    return names;
}

json ControlService::call_tool(std::string_view token, std::string_view tool, const json& args,
                               const json& context) {
    const std::lock_guard lock(mutex_);
    // Offered by the local command line only, so a client that is triggered from
    // outside can register that trigger by itself. Not listed with the tools.
    if (tool == "own_wake_hook") {
        const Session session = identity_.authenticate(token);
        identity_.require_active(session);
        return own_wake_hook(session, args);
    }
    if (std::ranges::find(agent_tools(), tool) == agent_tools().end()) {
        fail("UNKNOWN_TOOL", std::format("tool {} is not available", tool));
    }
    const Session session = identity_.authenticate(token);
    const bool open = open_mode(database_);
    // The two tools an unapproved session may use: see its own state, and ask to be paired.
    if (tool == "request_pairing") {
        json result = identity_.request_pairing(session, args);
        if (open && result.at("status") == "active") {
            conversations_.join_lobby(identity_.authenticate(token));
        }
        return result;
    }
    // Default interconnection: every approved, linked session is in its project's lobby.
    if (open && session.status == "active") {
        conversations_.join_lobby(session);
    }
    // Which conversation of its application the call comes from. A window that is
    // only known from its tool calls is kept alive by them.
    std::optional<Window> known;
    if (session.status == "active") {
        known = database_.transaction([&] {
            auto found = windows_.resolve(session, optional_string(context, "client", 32),
                                          optional_string(context, "client_session", 256), std::nullopt);
            if (found) {
                database_.execute("UPDATE windows SET seen_at = ?, event = 'tool' WHERE window_id = ? AND hooked = 0",
                                  to_rfc3339(clock_()), found->window_id);
            }
            return found;
        });
    }
    const Window* window = known ? &*known : nullptr;
    const json window_view = window != nullptr ? json{{"window_id", window->window_id}, {"name", window->name}}
                                               : json(nullptr);
    if (tool == "get_session") {
        json view = identity_.describe(session);
        const bool active = session.status == "active";
        view["interconnection"] = {{"open_mode", open}, {"linked", session.linked}};
        view["conversations"] = active ? conversations_.list_for_session(session) : json::array();
        // Who else can be addressed, and what became of conversations this session asked for.
        view["project_sessions"] = active ? roster(session, window) : json::array();
        view["proposals"] = active ? conversations_.proposals_of(session) : json::array();
        // The conversation this call comes from, as others address it.
        view["window"] = window_view;
        return view;
    }
    identity_.require_active(session);
    if (tool == "compact_conversation") {
        return compact(&session, args, window != nullptr ? window->name : session.label);
    }
    if (tool == "name_window") {
        if (window == nullptr) {
            fail("WINDOW_UNKNOWN",
                 "this client does not tell which of its conversations a call comes from, so there is no window to name");
        }
        return windows_.rename(session, *window, args);
    }
    if (tool == "bot_request") {
        return bots_.request(session, args);
    }
    if (tool == "bot_requests") {
        return bots_.list(session, args);
    }
    if (tool == "bot_pull") {
        return bots_.pull(session, args);
    }
    if (tool == "bot_respond") {
        return bots_.respond(session, args);
    }
    if (tool == "direct_message") {
        // Opens the pair's private conversation when needed, then goes through
        // the one message write path like any other send.
        const auto peer = require_string(args, "to_session_id", 96);
        std::vector<Window> targets = target_windows(session, args);
        for (const auto& target : targets) {
            if (target.session_id != peer) {
                fail("INVALID_RECIPIENT", std::format("window {} does not belong to session {}", target.name, peer),
                     {{"window", target.name}});
            }
        }
        refuse_out_of_quota({peer}, targets);
        const json conversation = conversations_.direct(session, peer);
        json draft = args;
        draft.erase("to_session_id");
        draft["conversation_id"] = conversation.at("conversation_id");
        return messages_.send(session, draft, window, std::move(targets));
    }
    if (tool == "list_conversations") {
        return {{"conversations", conversations_.list_for_session(session)}};
    }
    if (tool == "get_conversation") {
        return conversations_.get_for_session(session, require_string(args, "conversation_id", 96));
    }
    if (tool == "check_in") {
        return check_in(session, args, window);
    }
    if (tool == "read_messages") {
        json page = messages_.read(session, args);
        // Reading by hand also counts as caught up, so check_in does not repeat it.
        messages_.advance_cursor(session, page.at("conversation_id").get<std::string>(),
                                 page.at("next_cursor").get<std::int64_t>(), window);
        return page;
    }
    if (tool == "forward_message") {
        return messages_.forward(session, args);
    }
    if (tool == "list_tasks") {
        return board_.list_tasks(session, args);
    }
    if (tool == "create_task") {
        return board_.create_task(session, args);
    }
    if (tool == "update_task") {
        return board_.update_task(session, args);
    }
    if (tool == "propose_conversation") {
        return conversations_.propose(session, args);
    }
    if (tool == "send_message") {
        std::vector<Window> targets = target_windows(session, args);
        refuse_out_of_quota(args.contains("recipient_session_ids") ? optional_string_list(args, "recipient_session_ids")
                                                                    : std::vector<std::string>(),
                            targets);
        return messages_.send(session, args, window, std::move(targets));
    }
    if (tool == "get_inbox") {
        return messages_.inbox(session, args);
    }
    if (tool == "acknowledge_message") {
        return messages_.acknowledge(session, args);
    }
    if (tool == "report_progress") {
        return progress_.report_progress(session, args);
    }
    if (tool == "publish_artifact") {
        return progress_.publish_artifact(session, args);
    }
    return progress_.get_artifact(session, args);
}

json ControlService::enroll(std::string_view token, const json& args) {
    const std::lock_guard lock(mutex_);
    json session = identity_.enroll(token, args);
    if (session.at("status") == "active" && open_mode(database_)) {
        conversations_.join_lobby(identity_.authenticate(token));
    }
    return session;
}

json ControlService::hook(std::string_view token, const json& args) {
    const std::lock_guard lock(mutex_);
    return delivery_.hook(identity_.authenticate(token), args);
}

json ControlService::admin(std::string_view operation, std::string_view target_id, const json& args) {
    const std::lock_guard lock(mutex_);
    if (operation == "bootstrap") {
        // One consistent view plus the event watermark the console resumes from.
        return {{"projects", conversations_.list_projects()},
                {"agents", identity_.list_agents()},
                {"conversations", conversations_.list_all()},
                {"sessions", identity_.list_sessions()},
                {"proposals", conversations_.list_proposals()},
                {"settings", settings_view()},
                {"bot_requests", bots_.admin_list()},
                {"wake_hooks", wake_.list()},
                {"client_hooks", delivery_.list()},
                // Clients the gateway can start for an urgent message while they are idle.
                {"dispatch_clients", delivery_.command_clients()},
                // Clients that have used up their quota, and until when (their vendor's word).
                {"client_limits", delivery_.limits()},
                {"remote_access", remote_view()},
                // What a current bridge offers; a session reporting another number runs an older bridge.
                {"tool_count", agent_tools().size()},
                {"tool_contract", kToolContract},
                {"event_watermark", events_.watermark()},
                {"schema_version", database_.schema_version()}};
    }
    if (operation == "create_project") {
        return conversations_.create_project(args);
    }
    if (operation == "create_agent") {
        return identity_.create_agent(args);
    }
    if (operation == "create_pairing") {
        return identity_.create_pairing(args);
    }
    if (operation == "list_sessions") {
        return {{"sessions", identity_.list_sessions()}};
    }
    if (operation == "approve_pairing") {
        return identity_.approve_pairing(target_id);
    }
    if (operation == "revoke_session") {
        json session = identity_.revoke_session(target_id);
        // A withdrawn credential also leaves the lobby and its direct conversations.
        conversations_.apply_link(target_id, false);
        return session;
    }
    if (operation == "set_settings") {
        // Any subset of the settings may be given; what is absent stays as it is.
        if (!args.is_object() || args.empty()) {
            fail("INVALID_ARGUMENT", "give open_mode, the message limits and/or grok_bot_id to change");
        }
        // Which Grok Bot the console's "prefill" links open; empty means the primary bot.
        std::optional<std::string> grok_bot_id;
        if (args.contains("grok_bot_id")) {
            if (!args.at("grok_bot_id").is_string()) {
                fail("INVALID_ARGUMENT", "grok_bot_id must be text");
            }
            grok_bot_id = args.at("grok_bot_id").get<std::string>();
            const bool plain = std::ranges::all_of(*grok_bot_id, [](unsigned char c) {
                return std::isalnum(c) != 0 || c == '-' || c == '_';
            });
            if (grok_bot_id->size() > 128 || !plain) {
                fail("INVALID_ARGUMENT", "grok_bot_id is the id at the end of the bot's share link: letters, digits, - and _");
            }
        }
        if (args.contains("open_mode") && !args.at("open_mode").is_boolean()) {
            fail("INVALID_ARGUMENT", "open_mode must be true or false");
        }
        if (args.contains("alerts_enabled") && !args.at("alerts_enabled").is_boolean()) {
            fail("INVALID_ARGUMENT", "alerts_enabled must be true or false");
        }
        // The operator's standing rules for every session; empty removes them.
        const auto shared_rules = optional_string(args, "shared_rules", 6000);
        if (args.contains("agent_compact") && !args.at("agent_compact").is_boolean()) {
            fail("INVALID_ARGUMENT", "agent_compact must be true or false");
        }
        MessageLimits limits = message_limits(database_);
        const MessageLimits before = limits;
        limits.per_minute = optional_integer(args, "message_rate_per_minute", limits.per_minute, 0, 100000);
        limits.per_hour = optional_integer(args, "message_rate_per_hour", limits.per_hour, 0, 1000000);
        limits.duplicate_window_seconds =
            optional_integer(args, "duplicate_window_seconds", limits.duplicate_window_seconds, 0, 86400);
        limits.urgent_per_hour = optional_integer(args, "urgent_per_hour", limits.urgent_per_hour, 0, 100000);
        database_.transaction([&] {
            if (args.contains("open_mode") && open_mode(database_) != args.at("open_mode").get<bool>()) {
                set_open_mode(database_, args.at("open_mode").get<bool>());
                events_.append("settings.changed", {}, "open_mode", {{"open_mode", args.at("open_mode")}});
            }
            if (grok_bot_id) {
                grok_bot_id->empty() ? erase_setting(database_, "grok_bot_id")
                                     : store_text_setting(database_, "grok_bot_id", *grok_bot_id);
            }
            if (args.contains("alerts_enabled")) {
                store_text_setting(database_, "alerts_enabled", args.at("alerts_enabled").get<bool>() ? "1" : "0");
            }
            if (args.contains("agent_compact")) {
                store_text_setting(database_, "agent_compact", args.at("agent_compact").get<bool>() ? "1" : "0");
            }
            if (shared_rules && *shared_rules != text_setting(database_, "shared_rules").value_or("")) {
                shared_rules->empty() ? erase_setting(database_, "shared_rules")
                                      : store_text_setting(database_, "shared_rules", *shared_rules);
                // The time of the change is the version: windows are told the rules again.
                store_text_setting(database_, "shared_rules_at", to_rfc3339(clock_()));
                // The event says that they changed, not what they say.
                events_.append("settings.changed", {}, "shared_rules", {{"bytes", shared_rules->size()}});
            }
            if (limits.per_minute != before.per_minute || limits.per_hour != before.per_hour ||
                limits.duplicate_window_seconds != before.duplicate_window_seconds ||
                limits.urgent_per_hour != before.urgent_per_hour) {
                set_message_limits(database_, limits);
                events_.append("settings.changed", {}, "message_limits",
                               {{"message_rate_per_minute", limits.per_minute},
                                {"message_rate_per_hour", limits.per_hour},
                                {"duplicate_window_seconds", limits.duplicate_window_seconds},
                                {"urgent_per_hour", limits.urgent_per_hour}});
            }
        });
        return settings_view();
    }
    if (operation == "set_remote_access") {
        // {enabled?, authtoken?, domain?}: the tunnel credential is write-only.
        if (!args.is_object() || args.empty()) {
            fail("INVALID_ARGUMENT", "give enabled, authtoken and/or domain");
        }
        if (args.contains("enabled") && !args.at("enabled").is_boolean()) {
            fail("INVALID_ARGUMENT", "enabled must be true or false");
        }
        const auto authtoken = optional_string(args, "authtoken", 256);
        const bool has_domain = args.contains("domain");
        const auto domain = has_domain && args.at("domain").is_string() && args.at("domain").get<std::string>().empty()
                                ? std::optional<std::string>()
                                : optional_string(args, "domain", 253);
        if (domain && domain->find_first_of(" /\\:@") != std::string::npos) {
            fail("INVALID_ARGUMENT", "domain is a host name such as name.ngrok.app, without scheme or path");
        }
        database_.transaction([&] {
            if (authtoken) {
                store_text_setting(database_, "remote_authtoken", *authtoken);
            }
            if (has_domain) {
                if (domain) {
                    store_text_setting(database_, "remote_domain", *domain);
                } else {
                    erase_setting(database_, "remote_domain");
                }
            }
            if (args.contains("enabled")) {
                const bool enabled = args.at("enabled").get<bool>();
                if (enabled && !text_setting(database_, "remote_authtoken")) {
                    fail("INVALID_ARGUMENT", "an ngrok authtoken is required before remote access can be switched on");
                }
                // The tunnel component is optional and is installed only when the operator asks for it.
                if (enabled && text_setting(database_, "remote_component").value_or("missing") != "installed") {
                    fail("INVALID_ARGUMENT", "the ngrok component is not installed; install it first");
                }
                store_text_setting(database_, "remote_enabled", enabled ? "1" : "0");
            }
            // The event says that the setting changed, never the credential or the address.
            events_.append("remote.changed", {}, "remote_access",
                           {{"enabled", text_setting(database_, "remote_enabled").value_or("0") == "1"}});
        });
        return remote_view();
    }
    if (operation == "request_remote_install") {
        // The operator asks for the optional tunnel component; the gateway downloads and installs it.
        if (text_setting(database_, "remote_component").value_or("missing") != "installed") {
            store_text_setting(database_, "remote_install_requested", "1");
            store_text_setting(database_, "remote_component", "installing");
            erase_setting(database_, "remote_component_detail");
            database_.transaction([&] {
                events_.append("remote.changed", {}, "remote_access", {{"component", "installing"}});
            });
        }
        return remote_view();
    }
    if (operation == "remote_config") {
        // For the gateway, which opens the tunnel: the one place the credential is read back.
        return {{"enabled", text_setting(database_, "remote_enabled").value_or("0") == "1"},
                {"install_requested", text_setting(database_, "remote_install_requested").value_or("0") == "1"},
                {"authtoken", text_setting(database_, "remote_authtoken").value_or("")},
                {"domain", text_setting(database_, "remote_domain").value_or("")}};
    }
    if (operation == "remote_report") {
        const auto state = require_string(args, "state", 16);
        if (state != "stopped" && state != "starting" && state != "online" && state != "error") {
            fail("INVALID_ARGUMENT", "state must be stopped, starting, online or error");
        }
        const auto url = optional_string(args, "public_url", 512);
        const auto detail = optional_string(args, "detail", 500);
        // Whether the optional component is there: missing, installing, installed or failed.
        const auto component = optional_string(args, "component", 16);
        const auto component_detail = optional_string(args, "component_detail", 500);
        if (component && *component != "missing" && *component != "installing" && *component != "installed" &&
            *component != "failed") {
            fail("INVALID_ARGUMENT", "component must be missing, installing, installed or failed");
        }
        database_.transaction([&] {
            bool changed = text_setting(database_, "remote_state") != std::optional<std::string>(state) ||
                           text_setting(database_, "remote_url") != url;
            if (component) {
                changed = changed || text_setting(database_, "remote_component") != component;
                store_text_setting(database_, "remote_component", *component);
                component_detail ? store_text_setting(database_, "remote_component_detail", *component_detail)
                                 : erase_setting(database_, "remote_component_detail");
                if (*component != "installing") {
                    // The request was carried out, one way or the other.
                    erase_setting(database_, "remote_install_requested");
                }
            }
            store_text_setting(database_, "remote_state", state);
            url ? store_text_setting(database_, "remote_url", *url) : erase_setting(database_, "remote_url");
            detail ? store_text_setting(database_, "remote_detail", *detail) : erase_setting(database_, "remote_detail");
            if (changed) {
                events_.append("remote.changed", {}, "remote_access", {{"state", state}});
            }
        });
        return remote_view();
    }
    if (operation == "set_wake_hook") {
        return wake_.set(target_id, args);
    }
    if (operation == "remove_wake_hook") {
        return wake_.remove(target_id);
    }
    if (operation == "test_wake_hook") {
        return wake_.request_test(target_id);
    }
    if (operation == "wake_claim") {
        return wake_.claim();
    }
    if (operation == "wake_report") {
        return wake_.report(args);
    }
    if (operation == "rename_window") {
        return windows_.admin_rename(target_id, args);
    }
    if (operation == "import_windows") {
        return windows_.import(args);
    }
    if (operation == "compactions") {
        conversations_.get(target_id);
        return json{{"compactions", conversations_.compactions(target_id)}};
    }
    if (operation == "stats") {
        return stats(optional_integer(args, "days", 7, 1, 90));
    }
    if (operation == "digests") {
        conversations_.get(target_id);
        return json{{"digests", conversations_.digests(target_id)}};
    }
    if (operation == "use_digest") {
        if (!args.is_object() || !args.contains("digest_id") || !args.at("digest_id").is_number_integer()) {
            fail("INVALID_ARGUMENT", "digest_id is required");
        }
        return conversations_.use_digest(target_id, args.at("digest_id").get<std::int64_t>());
    }
    if (operation == "compact_conversation") {
        json with_target = args.is_object() ? args : json::object();
        with_target["conversation_id"] = target_id;
        return compact(nullptr, with_target, "the operator");
    }
    if (operation == "delivery_claim") {
        return delivery_.claim(args);
    }
    if (operation == "delivery_report") {
        return delivery_.report(args);
    }
    if (operation == "delivery_ended") {
        return delivery_.turn_ended(args);
    }
    if (operation == "delivery_limit") {
        return json{{"client_limits", delivery_.set_limit(args)}};
    }
    if (operation == "approve_bot_request" || operation == "reject_bot_request") {
        return bots_.decide(target_id, operation == "approve_bot_request");
    }
    if (operation == "set_session") {
        // {linked?, rate_exempt?, urgent_dispatch?}: at least one, each true or false.
        const bool has_linked = args.is_object() && args.contains("linked");
        const bool has_exempt = args.is_object() && args.contains("rate_exempt");
        const bool has_dispatch = args.is_object() && args.contains("urgent_dispatch");
        if ((!has_linked && !has_exempt && !has_dispatch) || (has_linked && !args.at("linked").is_boolean())) {
            fail("INVALID_ARGUMENT", "linked must be true or false");
        }
        if (has_exempt && !args.at("rate_exempt").is_boolean()) {
            fail("INVALID_ARGUMENT", "rate_exempt must be true or false");
        }
        if (has_dispatch && !args.at("urgent_dispatch").is_boolean()) {
            fail("INVALID_ARGUMENT", "urgent_dispatch must be true or false");
        }
        json session;
        if (has_exempt) {
            session = identity_.set_rate_exempt(target_id, args.at("rate_exempt").get<bool>());
        }
        if (has_dispatch) {
            session = identity_.set_urgent_dispatch(target_id, args.at("urgent_dispatch").get<bool>());
        }
        if (has_linked) {
            const bool linked = args.at("linked").get<bool>();
            session = identity_.set_linked(target_id, linked);
            conversations_.apply_link(target_id, linked);
        }
        return session;
    }
    if (operation == "create_conversation") {
        return conversations_.create_conversation(args);
    }
    if (operation == "get_conversation") {
        return conversations_.get(target_id);
    }
    if (operation == "update_conversation") {
        return conversations_.update(target_id, args);
    }
    if (operation == "clear_conversation") {
        return conversations_.clear_messages(target_id, args);
    }
    if (operation == "delete_conversation") {
        return conversations_.remove(target_id);
    }
    if (operation == "set_members") {
        return conversations_.set_members(target_id, args);
    }
    if (operation == "read_messages") {
        return messages_.read_all(target_id, args);
    }
    if (operation == "send_message") {
        json with_target = args.is_object() ? args : json::object();
        with_target["conversation_id"] = target_id;
        // The operator may name windows like any sender; they are looked up in the conversation's project.
        std::vector<Window> targets;
        if (const auto handles = optional_string_list(with_target, "to_windows"); !handles.empty()) {
            targets = windows_.lookup(conversations_.get(target_id).at("project_id").get<std::string>(), handles);
        }
        refuse_out_of_quota(with_target.contains("recipient_session_ids")
                                ? optional_string_list(with_target, "recipient_session_ids")
                                : std::vector<std::string>(),
                            targets);
        return messages_.send_as_operator(with_target, std::move(targets));
    }
    if (operation == "set_goal") {
        return conversations_.set_goal(target_id, args);
    }
    if (operation == "list_tasks") {
        return {{"tasks", board_.tasks(target_id, true)}};
    }
    if (operation == "create_task") {
        return board_.admin_create_task(target_id, args);
    }
    if (operation == "update_task") {
        return board_.admin_update_task(target_id, args);
    }
    if (operation == "approve_proposal" || operation == "reject_proposal") {
        return conversations_.decide_proposal(target_id, operation == "approve_proposal");
    }
    if (operation == "list_artifacts") {
        return {{"artifacts", progress_.list_artifacts(target_id)}};
    }
    fail("UNKNOWN_OPERATION", std::format("operator operation {} is not available", operation));
}

std::vector<Window> ControlService::target_windows(const Session& session, const json& args) {
    const std::vector<std::string> handles = optional_string_list(args, "to_windows");
    return handles.empty() ? std::vector<Window>() : windows_.lookup(session.project_id, handles);
}

namespace {

// Cuts at a character boundary and says that it did.
json overview_text(const json& value, std::size_t limit) {
    if (!value.is_string()) {
        return value;
    }
    std::string text = value.get<std::string>();
    if (text.size() <= limit) {
        return text;
    }
    std::size_t end = limit;
    while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) {
        --end;
    }
    text.resize(end);
    return text + " [...]";
}

// What a session needs of a task to see where the work stands; list_tasks has all of it.
json task_overview(const json& task) {
    return {{"task_id", task.at("task_id")},
            {"number", task.at("number")},
            {"title", task.at("title")},
            {"status", task.at("status")},
            {"assignee", task.at("assignee").is_null() ? json(nullptr) : task.at("assignee").at("label")},
            {"note", overview_text(task.at("note"), 240)},
            {"detail", overview_text(task.at("detail"), 240)},
            {"version", task.at("version")},
            {"updated_at", task.at("updated_at")}};
}

}  // namespace

json ControlService::stats(std::int64_t days) {
    const auto now = clock_();
    const std::string from = to_rfc3339(now - std::chrono::hours(24 * days));
    // An hour is the first 13 characters of an RFC 3339 time, a day the first 10.
    const std::int64_t cut = days <= 1 ? 13 : 10;
    // What people and sessions wrote; system notes and progress records are not conversation.
    const std::string written = "m.kind IN ('message', 'handoff', 'decision') AND m.created_at >= ?";
    json result = {{"days", days}, {"from", from}, {"to", to_rfc3339(now)}, {"bucket", days <= 1 ? "hour" : "day"}};

    json buckets = json::array();
    Statement series = database_.query(
        std::format("SELECT substr(m.created_at, 1, {}), COUNT(*), COALESCE(SUM(m.urgent), 0) FROM messages m WHERE {} "
                    "GROUP BY 1 ORDER BY 1",
                    cut, written),
        from);
    std::int64_t total = 0;
    std::int64_t urgent = 0;
    while (series.step()) {
        buckets.push_back({{"at", series.text(0)}, {"messages", series.integer(1)}, {"urgent", series.integer(2)}});
        total += series.integer(1);
        urgent += series.integer(2);
    }
    result["series"] = std::move(buckets);
    result["messages"] = total;
    result["urgent"] = urgent;

    json senders = json::array();
    Statement who = database_.query(
        std::format("SELECT m.sender_kind, a.display_name, s.label, a.provider, COUNT(*) FROM messages m "
                    "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
                    "LEFT JOIN agents a ON a.agent_id = s.agent_id WHERE {} "
                    "GROUP BY m.sender_kind, m.sender_session_id ORDER BY 5 DESC LIMIT 12",
                    written),
        from);
    while (who.step()) {
        const bool operator_ = who.text(0) == "operator";
        senders.push_back({{"name", operator_ ? std::string("operator") : who.optional_text(1).value_or("?")},
                           {"label", operator_ ? json(nullptr) : json(who.optional_text(2).value_or(""))},
                           {"provider", operator_ ? json(nullptr) : json(who.optional_text(3).value_or(""))},
                           {"messages", who.integer(4)}});
    }
    result["senders"] = std::move(senders);

    json windows = json::array();
    Statement where = database_.query(
        std::format("SELECT w.name, a.display_name, COUNT(*) FROM messages m JOIN windows w ON w.window_id = m.author_window_id "
                    "JOIN agent_sessions s ON s.session_id = w.session_id LEFT JOIN agents a ON a.agent_id = s.agent_id "
                    "WHERE {} GROUP BY m.author_window_id ORDER BY 3 DESC LIMIT 10",
                    written),
        from);
    while (where.step()) {
        windows.push_back({{"name", where.text(0)}, {"app", where.optional_text(1).value_or("")}, {"messages", where.integer(2)}});
    }
    result["windows"] = std::move(windows);
    Statement active = database_.query("SELECT COUNT(*) FROM windows WHERE seen_at >= ?", from);
    active.step();
    result["active_windows"] = active.integer(0);

    json places = json::array();
    Statement in = database_.query(
        std::format("SELECT c.conversation_id, c.kind, c.title, c.task_code, COUNT(*), "
                    // A direct conversation is told apart by the two that talk in it.
                    "(SELECT GROUP_CONCAT(a.display_name, ' ↔ ') FROM conversation_members cm "
                    " JOIN agent_sessions s ON s.session_id = cm.session_id JOIN agents a ON a.agent_id = s.agent_id "
                    " WHERE cm.conversation_id = c.conversation_id) "
                    "FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE {} "
                    "GROUP BY m.conversation_id ORDER BY 5 DESC LIMIT 8",
                    written),
        from);
    while (in.step()) {
        places.push_back({{"conversation_id", in.text(0)},
                          {"kind", in.text(1)},
                          {"title", in.text(2)},
                          {"task_code", in.text(3)},
                          {"messages", in.integer(4)},
                          {"members", in.optional_text(5).value_or("")}});
    }
    result["conversations"] = std::move(places);

    // How urgent messages were handed over: by the hooks inside a conversation, or by a command.
    json handed = {{"ok", 0}, {"failed", 0}, {"skipped", 0}, {"running", 0}};
    json routes = json::object();
    Statement outcomes = database_.query(
        "SELECT route, status, COUNT(*) FROM deliveries WHERE urgent > 0 AND route IN ('stop', 'watch', 'command', 'tool') "
        "AND created_at >= ? GROUP BY route, status",
        from);
    while (outcomes.step()) {
        handed[outcomes.text(1)] = handed.value(outcomes.text(1), std::int64_t{0}) + outcomes.integer(2);
        json& route = routes[outcomes.text(0)];
        if (route.is_null()) {
            route = {{"ok", 0}, {"failed", 0}, {"skipped", 0}, {"running", 0}};
        }
        route[outcomes.text(1)] = outcomes.integer(2);
    }
    result["deliveries"] = std::move(handed);
    result["delivery_routes"] = std::move(routes);

    json tasks = {{"todo", 0}, {"doing", 0}, {"blocked", 0}, {"done", 0}, {"cancelled", 0}};
    Statement board = database_.query(
        "SELECT t.status, COUNT(*) FROM tasks t JOIN conversations c ON c.conversation_id = t.conversation_id "
        "WHERE c.status = 'open' GROUP BY t.status");
    while (board.step()) {
        tasks[board.text(0)] = board.integer(1);
    }
    result["tasks"] = std::move(tasks);
    return result;
}

json ControlService::compact(const Session* session, const json& args, const std::string& by) {
    const auto conversation_id = require_string(args, "conversation_id", 96);
    const bool messages = std::ranges::any_of(std::array{"summary", "keep", "drop", "resolve", "restore"},
                                              [&](const char* field) { return args.contains(field); });
    const bool tasks = args.contains("close_tasks");
    json result;
    if (messages || !tasks) {
        result = conversations_.compact(session, args, by);
    } else {
        // Tasks only: the same rules for who may do it.
        if (session != nullptr) {
            conversations_.require_writer(*session, conversation_id);
            if (text_setting(database_, "agent_compact").value_or("1") != "1") {
                fail("COMPACT_DISABLED", "the operator has switched off compacting by agents; it is done at the console");
            }
        }
        result = {{"conversation_id", conversation_id}, {"digest", conversations_.digest(conversation_id)}};
    }
    if (tasks) {
        // Settled tasks leave the board that every check_in carries.
        result["closed_tasks"] =
            board_.close(session, conversation_id, args.at("close_tasks"), std::format("Closed by {} while compacting", by));
        result["open_tasks"] = board_.tasks(conversation_id, false).size();
    }
    return result;
}

json ControlService::quota_of_session(std::string_view session_id, const json& active_limits) {
    Statement clients = database_.query("SELECT DISTINCT client FROM windows WHERE session_id = ? AND client <> ''", session_id);
    while (clients.step()) {
        const std::string client = clients.text(0);
        if (active_limits.contains(client)) {
            json limit = active_limits.at(client);
            limit["client"] = client;
            return limit;
        }
    }
    return nullptr;
}

void ControlService::refuse_out_of_quota(const std::vector<std::string>& sessions, const std::vector<Window>& targets) {
    std::vector<std::string> named = sessions;
    if (!targets.empty()) {
        named.clear();
        for (const auto& target : targets) {
            named.push_back(target.session_id);
        }
    }
    if (named.empty()) {
        return;
    }
    const json active_limits = delivery_.limits();
    if (active_limits.empty()) {
        return;
    }
    json first;
    for (const auto& id : named) {
        json limit = quota_of_session(id, active_limits);
        if (limit.is_null()) {
            return;
        }
        if (first.is_null()) {
            first = std::move(limit);
            first["session_id"] = id;
        }
    }
    fail("CLIENT_OUT_OF_QUOTA",
         std::format("{} quota is exhausted until {}; targeted messages are paused until reset. Route this work to "
                     "another active session (see out_of_quota in project_sessions).",
                     first.value("client", std::string("target client")), first.value("until", std::string())),
         first);
}

json ControlService::roster(const Session& session, const Window* window, bool all_windows) {
    json sessions = conversations_.roster(session);
    const json active_limits = delivery_.limits();
    for (auto& entry : sessions) {
        // The single conversations of that application, each addressable by its name. The
        // most recently used ones by default: a full list of dozens costs every reader.
        const std::string id = entry.at("session_id").get<std::string>();
        entry["windows"] = windows_.of_session(id, window, all_windows ? 40 : Windows::kRosterWindows);
        if (!active_limits.empty()) {
            for (const auto& listed : entry.at("windows")) {
                const std::string client = windows_.client_of(listed.at("window_id").get<std::string>());
                if (!client.empty() && active_limits.contains(client)) {
                    entry["out_of_quota"] = active_limits.at(client);
                    break;
                }
            }
        }
        const std::int64_t more = windows_.count_of_session(id) - static_cast<std::int64_t>(entry.at("windows").size());
        if (more > 0) {
            // check_in with all_windows true lists these too.
            entry["windows_not_listed"] = more;
        }
    }
    return sessions;
}

json ControlService::check_in(const Session& session, const json& args, const Window* window) {
    const auto only = optional_string(args, "conversation_id", 96);
    const auto limit = optional_integer(args, "limit", 15, 1, 200);
    const bool all_windows = optional_bool(args, "all_windows", false);
    if (only) {
        conversations_.require_member(session, *only);
    }
    json conversations = json::array();
    for (const auto& entry : conversations_.list_for_session(session)) {
        const std::string id = entry.at("conversation_id");
        if (only && id != *only) {
            continue;
        }
        json item = {{"conversation_id", id},
                     {"task_code", entry.at("task_code")},
                     {"title", entry.at("title")},
                     {"kind", entry.at("kind")},
                     {"can_read", entry.at("can_read")},
                     {"can_write", entry.at("can_write")}};
        if (entry.contains("with")) {
            item["with"] = entry.at("with");
        }
        // Goal, board and messages are conversation content: readers only.
        if (entry.at("can_read").get<bool>()) {
            item["goal"] = conversations_.get(id).at("goal");
            // The open tasks, each as an overview; the newest fifteen when there are more.
            const json open_tasks = board_.tasks(id, false);
            json listed_tasks = json::array();
            const std::size_t first = open_tasks.size() > 15 ? open_tasks.size() - 15 : 0;
            for (std::size_t index = first; index < open_tasks.size(); ++index) {
                listed_tasks.push_back(task_overview(open_tasks.at(index)));
            }
            item["tasks"] = std::move(listed_tasks);
            if (first > 0) {
                item["tasks_not_listed"] = first;
            }
            const json page = messages_.unread(session, id, limit, window);
            item["new_messages"] = page.at("messages");
            item["has_more"] = page.at("has_more");
            item["next_cursor"] = page.at("next_cursor");
            // What was said before, in one text, when this reader was behind it.
            if (page.contains("digest")) {
                item["digest"] = page.at("digest");
            }
            // Older messages that compacting kept in front of readers.
            if (page.contains("kept_messages")) {
                item["kept_messages"] = page.at("kept_messages");
            }
            if (page.at("skipped_earlier").get<std::int64_t>() > 0) {
                item["skipped_earlier"] = page.at("skipped_earlier");
            }
            // Much was said since the last digest and this caller wrote most of it: it is the one to summarize.
            const std::string* window_id = window != nullptr ? &window->window_id : nullptr;
            if (entry.at("can_write").get<bool>() && conversations_.digest_due(session, id, window_id)) {
                item["digest_due"] = true;
            }
        }
        conversations.push_back(std::move(item));
    }
    // Outcomes of bot requests this session made, and requests waiting for it as a bot host.
    const json bot_news = bots_.news(session);
    return {{"session_id", session.session_id},
            {"label", session.label},
            // The conversation this call comes from: its name is how others address it (to_windows).
            {"window", window != nullptr ? json{{"window_id", window->window_id}, {"name", window->name}} : json(nullptr)},
            // The operator's standing rules for every session (set at the console, by the
            // person who runs these sessions; not a peer's message). Null when there are none.
            {"shared_rules", text_setting(database_, "shared_rules")
                                 ? json{{"text", *text_setting(database_, "shared_rules")},
                                        {"updated_at", text_setting(database_, "shared_rules_at").value_or("")}}
                                 : json(nullptr)},
            {"unacknowledged", messages_.pending_count(session)},
            {"bot_results", bot_news.at("results")},
            {"bot_requests_waiting_for_you", bot_news.at("waiting_for_you")},
            {"conversations", conversations},
            // Who can be reached with direct_message.
            {"project_sessions", roster(session, window, all_windows)},
            {"proposals", conversations_.proposals_of(session)}};
}

json ControlService::own_wake_hook(const Session& session, const json& args) {
    const auto op = require_string(args, "op", 16);
    if (op == "set") {
        json fields = {{"url", require_string(args, "url", 2048)}, {"enabled", true}};
        if (const auto key = optional_string(args, "key", 512)) {
            fields["key"] = *key;
        }
        if (args.contains("include_text")) {
            fields["include_text"] = optional_bool(args, "include_text", false);
        }
        wake_.set(session.session_id, fields);
    } else if (op == "test") {
        wake_.request_test(session.session_id);
    } else if (op == "remove") {
        wake_.remove(session.session_id);
    } else if (op != "status") {
        fail("INVALID_ARGUMENT", "op must be set, test, status or remove");
    }
    Statement row = database_.query(
        "SELECT host_seen_at, (SELECT COUNT(*) FROM bot_requests r WHERE r.host_session_id = s.session_id AND "
        "r.status = 'queued') FROM agent_sessions s WHERE s.session_id = ?",
        session.session_id);
    row.step();
    return {{"session_id", session.session_id},
            {"hook", wake_.find(session.session_id)},
            // When this session last asked for bot requests: a run that was triggered shows up here.
            {"host_seen_at", row.optional_text(0) ? json(*row.optional_text(0)) : json(nullptr)},
            {"queued_requests", row.integer(1)}};
}

json ControlService::settings_view() {
    const MessageLimits limits = message_limits(database_);
    return {{"open_mode", open_mode(database_)},
            {"message_rate_per_minute", limits.per_minute},
            {"message_rate_per_hour", limits.per_hour},
            {"duplicate_window_seconds", limits.duplicate_window_seconds},
            {"urgent_per_hour", limits.urgent_per_hour},
            // Whether a route that stopped working is announced with a system notification.
            {"alerts_enabled", text_setting(database_, "alerts_enabled").value_or("1") == "1"},
            // Standing rules the operator set for every session, and when they last changed.
            {"shared_rules", text_setting(database_, "shared_rules").value_or("")},
            {"shared_rules_at", text_setting(database_, "shared_rules_at").value_or("")},
            // Whether sessions may compact conversations (digest, keep, drop) by themselves.
            {"agent_compact", text_setting(database_, "agent_compact").value_or("1") == "1"},
            {"grok_bot_id", text_setting(database_, "grok_bot_id").value_or("")}};
}

json ControlService::remote_view() {
    const auto optional = [&](std::string_view key) {
        const auto value = text_setting(database_, key);
        return value ? json(*value) : json(nullptr);
    };
    return {{"enabled", text_setting(database_, "remote_enabled").value_or("0") == "1"},
            {"has_authtoken", text_setting(database_, "remote_authtoken").has_value()},
            {"domain", optional("remote_domain")},
            {"state", text_setting(database_, "remote_state").value_or("stopped")},
            {"public_url", optional("remote_url")},
            {"detail", optional("remote_detail")},
            {"component", text_setting(database_, "remote_component").value_or("missing")},
            {"component_detail", optional("remote_component_detail")}};
}

json ControlService::events_after(std::int64_t after, std::int64_t limit) {
    const std::lock_guard lock(mutex_);
    return {{"events", events_.read_after(after, limit)}, {"watermark", events_.watermark()}};
}

int ControlService::schema_version() {
    const std::lock_guard lock(mutex_);
    return database_.schema_version();
}

}  // namespace acm
