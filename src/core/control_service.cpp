#include "control_service.hpp"

#include "settings.hpp"

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
      delivery_(database_, events_, clock) {
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
        "bot_pull",         "bot_respond"};
    return names;
}

json ControlService::call_tool(std::string_view token, std::string_view tool, const json& args) {
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
    if (tool == "get_session") {
        json view = identity_.describe(session);
        const bool active = session.status == "active";
        view["interconnection"] = {{"open_mode", open}, {"linked", session.linked}};
        view["conversations"] = active ? conversations_.list_for_session(session) : json::array();
        // Who else can be addressed, and what became of conversations this session asked for.
        view["project_sessions"] = active ? conversations_.roster(session) : json::array();
        view["proposals"] = active ? conversations_.proposals_of(session) : json::array();
        return view;
    }
    identity_.require_active(session);
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
        const json conversation = conversations_.direct(session, require_string(args, "to_session_id", 96));
        json draft = args;
        draft.erase("to_session_id");
        draft["conversation_id"] = conversation.at("conversation_id");
        return messages_.send(session, draft);
    }
    if (tool == "list_conversations") {
        return {{"conversations", conversations_.list_for_session(session)}};
    }
    if (tool == "get_conversation") {
        return conversations_.get_for_session(session, require_string(args, "conversation_id", 96));
    }
    if (tool == "check_in") {
        return check_in(session, args);
    }
    if (tool == "read_messages") {
        json page = messages_.read(session, args);
        // Reading by hand also counts as caught up, so check_in does not repeat it.
        messages_.advance_cursor(session, page.at("conversation_id").get<std::string>(),
                                 page.at("next_cursor").get<std::int64_t>());
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
        return messages_.send(session, args);
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
    if (operation == "delivery_claim") {
        return delivery_.claim(args);
    }
    if (operation == "delivery_report") {
        return delivery_.report(args);
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
        return messages_.send_as_operator(with_target);
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

json ControlService::check_in(const Session& session, const json& args) {
    const auto only = optional_string(args, "conversation_id", 96);
    const auto limit = optional_integer(args, "limit", 30, 1, 200);
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
            item["tasks"] = board_.tasks(id, false);
            const json page = messages_.unread(session, id, limit);
            item["new_messages"] = page.at("messages");
            item["has_more"] = page.at("has_more");
            item["next_cursor"] = page.at("next_cursor");
        }
        conversations.push_back(std::move(item));
    }
    // Outcomes of bot requests this session made, and requests waiting for it as a bot host.
    const json bot_news = bots_.news(session);
    return {{"session_id", session.session_id},
            {"label", session.label},
            {"unacknowledged", messages_.pending_count(session)},
            {"bot_results", bot_news.at("results")},
            {"bot_requests_waiting_for_you", bot_news.at("waiting_for_you")},
            {"conversations", conversations},
            // Who can be reached with direct_message.
            {"project_sessions", conversations_.roster(session)},
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
