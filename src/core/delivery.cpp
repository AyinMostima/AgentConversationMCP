#include "delivery.hpp"

#include "settings.hpp"

#include <algorithm>
#include <format>

namespace acm {

namespace {

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

bool is_event(std::string_view event) {
    return event == "start" || event == "prompt" || event == "stop" || event == "watch";
}

// Cuts at a character boundary: the text is UTF-8 and goes into a model's context.
std::string clip(std::string text, std::size_t limit) {
    if (text.size() <= limit) {
        return text;
    }
    std::size_t end = limit;
    while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) {
        --end;
    }
    text.resize(end);
    text += " [... cut; read_messages has the rest]";
    return text;
}

}  // namespace

std::vector<Delivery::Pending> Delivery::pending(std::string_view session_id, std::int64_t floor,
                                                 std::int64_t urgent_floor, bool urgent_only, std::int64_t limit) {
    std::vector<Pending> found;
    // What check_in would still return to this session, written by someone else.
    Statement rows = database_.query(
        "SELECT m.rowid, m.message_id, m.body, m.urgent, m.created_at, m.sender_kind, a.display_name, s.label, "
        "c.kind, c.title FROM messages m "
        "JOIN conversations c ON c.conversation_id = m.conversation_id AND c.status = 'open' "
        "JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.session_id = ? "
        "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
        "LEFT JOIN agents a ON a.agent_id = s.agent_id "
        "WHERE cm.removed_at IS NULL AND cm.can_read = 1 AND m.seq > cm.read_seq "
        "AND COALESCE(m.sender_session_id, '') <> ? "
        "AND (m.directed = 0 OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id "
        "AND r.session_id = ?)) "
        "AND m.kind IN ('message', 'handoff', 'decision') "
        "AND m.rowid > ? AND (m.urgent = 0 OR m.rowid > ?) AND (? = 0 OR m.urgent = 1) "
        "ORDER BY m.rowid LIMIT ?",
        session_id, session_id, session_id, floor, urgent_floor, urgent_only, limit);
    while (rows.step()) {
        const std::string from = rows.text(5) == "operator"
                                     ? std::string("the operator (console)")
                                     : std::format("{} ({})", rows.optional_text(6).value_or("unknown"),
                                                   rows.optional_text(7).value_or("?"));
        const std::string kind = rows.text(8);
        const std::string where = kind == "lobby"    ? std::string("the lobby")
                                  : kind == "direct" ? std::string("a direct conversation with you")
                                                     : std::format("\"{}\"", rows.text(9));
        found.push_back({rows.integer(0), rows.text(1), rows.text(2), rows.integer(3) != 0, rows.text(4), from, where});
    }
    return found;
}

std::int64_t Delivery::last_rowid() {
    Statement row = database_.query("SELECT COALESCE(MAX(rowid), 0) FROM messages");
    row.step();
    return row.integer(0);
}

std::string Delivery::compose(const std::vector<Pending>& listed, std::int64_t more, std::string_view route) {
    if (listed.empty()) {
        return {};
    }
    const bool interrupting = route == "stop" || route == "watch" || route == "command";
    const auto urgent = std::ranges::count_if(listed, [](const Pending& entry) { return entry.urgent; });
    std::string text;
    if (interrupting) {
        text = std::format("[ACM] Urgent: {} message(s) marked urgent arrived from other sessions on this machine.",
                           listed.size());
    } else {
        text = std::format("[ACM] {} new message(s) from other sessions on this machine", listed.size());
        text += urgent > 0 ? std::format(", {} of them urgent.", urgent) : std::string(".");
    }
    text += " They were written by peer AI sessions or at the operator console, not by the person typing in this "
            "conversation.\n";
    int number = 0;
    for (const auto& entry : listed) {
        text += std::format("\n{}. {}{} in {}, {}:\n{}\n", ++number, entry.urgent ? "[URGENT] " : "", entry.from,
                            entry.where, entry.created_at,
                            clip(entry.body, entry.urgent ? kUrgentBodyBytes : kBodyBytes));
    }
    text += "\n";
    if (more > 0) {
        text += std::format("{} more are waiting and are not listed here. ", more);
    }
    if (interrupting) {
        text += "Deal with them now: call the acm check_in tool, then answer with send_message or direct_message. "
                "Mark your answer urgent only if it cannot wait either.";
    } else {
        text += "Call the acm check_in tool to mark them read and to see the task board; answer with send_message "
                "or direct_message where an answer is needed.";
    }
    if (route == "command") {
        text += " This turn was started by ACM while the conversation was idle: use only the acm tools in it.";
    }
    return text;
}

json Delivery::hook(const Session& session, const json& args) {
    const auto event = require_string(args, "event", 16);
    if (!is_event(event)) {
        fail("INVALID_ARGUMENT", "event must be start, prompt, stop or watch");
    }
    const auto client = optional_string(args, "client", 32);
    const auto client_session = optional_string(args, "client_session", 256);
    const auto cwd = optional_string(args, "cwd", 1024);
    const auto watch_id = optional_string(args, "watch_id", 64);
    const bool peek = optional_bool(args, "peek", false);
    const bool urgent_only = event != "start" && event != "prompt";
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);

    return database_.transaction([&] {
        json result = {{"session_id", session.session_id}, {"event", event},        {"superseded", false},
                       {"count", 0},                       {"urgent", 0},           {"more", 0},
                       {"text", ""},                       {"messages", json::array()}};
        database_.execute("INSERT OR IGNORE INTO client_hooks (session_id, event, seen_at) VALUES (?, ?, ?)",
                          session.session_id, event == "watch" ? std::string("start") : event, now);
        if (event == "watch") {
            if (!watch_id) {
                fail("INVALID_ARGUMENT", "watch_id is required for the watch event");
            }
            Statement current = database_.query(
                "SELECT client_session, watch_session FROM client_hooks WHERE session_id = ?", session.session_id);
            current.step();
            // One watcher per session: the newest conversation's, and of those the newest process.
            const bool other_conversation = client_session && current.optional_text(0) &&
                                            *current.optional_text(0) != *client_session;
            const bool fresh = optional_bool(args, "fresh", false);
            const bool replaced = !fresh && current.optional_text(1) != watch_id;
            if (other_conversation || replaced) {
                result["superseded"] = true;
                return result;
            }
            database_.execute("UPDATE client_hooks SET watch_seen_at = ?, watch_session = ? WHERE session_id = ?", now,
                              *watch_id, session.session_id);
        } else if (!peek) {
            database_.execute(
                "UPDATE client_hooks SET event = ?, seen_at = ?, runs = runs + 1, client = COALESCE(?, client), "
                "client_session = COALESCE(?, client_session), cwd = COALESCE(?, cwd) WHERE session_id = ?",
                event, now, client, client_session, cwd, session.session_id);
        }
        if (session.status != "active") {
            return result;
        }

        Statement marks = database_.query("SELECT shown_rowid, urgent_rowid FROM client_hooks WHERE session_id = ?",
                                          session.session_id);
        marks.step();
        const std::int64_t shown = marks.integer(0);
        const std::int64_t urgent_mark = std::max(shown, marks.integer(1));
        if (urgent_only) {
            // The guard against sessions interrupting each other without end.
            Statement recent = database_.query(
                "SELECT COUNT(*) FROM deliveries WHERE session_id = ? AND route IN ('stop', 'watch', 'command') "
                "AND status <> 'failed' AND created_at > ?",
                session.session_id, to_rfc3339(moment - std::chrono::seconds(kWindowSeconds)));
            recent.step();
            if (recent.integer(0) >= kMaxUrgentDeliveries) {
                result["held"] = true;
                return result;
            }
        }
        // The prompt route lists everything unread it has not listed itself, also what
        // an urgent route delivered meanwhile: that delivery may have reached nobody,
        // and a model that dealt with it has read it by now.
        const std::int64_t floor = urgent_only ? urgent_mark : shown;
        std::vector<Pending> listed = pending(session.session_id, floor, floor, urgent_only, kMaxListed + 1);
        const bool cut = static_cast<std::int64_t>(listed.size()) > kMaxListed;
        if (cut) {
            listed.pop_back();
        }
        std::int64_t more = 0;
        if (cut) {
            const auto rest = pending(session.session_id, listed.back().rowid, floor, urgent_only, 1000);
            more = static_cast<std::int64_t>(rest.size());
        }
        const auto urgent = std::ranges::count_if(listed, [](const Pending& entry) { return entry.urgent; });
        json messages = json::array();
        for (const auto& entry : listed) {
            messages.push_back({{"message_id", entry.message_id},
                                {"from", entry.from},
                                {"in", entry.where},
                                {"urgent", entry.urgent},
                                {"sent_at", entry.created_at}});
        }
        result["count"] = listed.size();
        result["urgent"] = urgent;
        result["more"] = more;
        result["text"] = compose(listed, more, event);
        result["messages"] = std::move(messages);
        if (peek) {
            return result;
        }
        // Everything up to here has been looked at; a cut list ends at its last entry.
        const std::int64_t upto = cut ? listed.back().rowid : last_rowid();
        if (urgent_only) {
            database_.execute("UPDATE client_hooks SET urgent_rowid = MAX(urgent_rowid, ?) WHERE session_id = ?", upto,
                              session.session_id);
        } else {
            database_.execute(
                "UPDATE client_hooks SET shown_rowid = MAX(shown_rowid, ?), urgent_rowid = MAX(urgent_rowid, ?) "
                "WHERE session_id = ?",
                upto, upto, session.session_id);
        }
        if (!listed.empty()) {
            database_.execute(
                "INSERT INTO deliveries (session_id, created_at, route, status, upto_rowid, messages, urgent) "
                "VALUES (?, ?, ?, 'ok', ?, ?, ?)",
                session.session_id, now, event, upto, static_cast<std::int64_t>(listed.size()),
                static_cast<std::int64_t>(urgent));
            // The event says that messages were shown and how many, never their text.
            events_.append("delivery.shown", {.project_id = session.project_id, .actor_id = session.session_id},
                           session.session_id,
                           {{"session_id", session.session_id},
                            {"route", event},
                            {"messages", listed.size()},
                            {"urgent", urgent}});
        }
        return result;
    });
}

json Delivery::command_clients() {
    const auto stored = text_setting(database_, "dispatch_clients");
    json parsed = stored ? json::parse(*stored, nullptr, false) : json::array();
    return parsed.is_array() ? parsed : json::array();
}

json Delivery::claim(const json& args) {
    const bool limited = args.is_object() && args.contains("clients");
    const std::vector<std::string> clients = limited ? optional_string_list(args, "clients") : std::vector<std::string>();
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    const auto ago = [&](std::int64_t seconds) { return to_rfc3339(moment - std::chrono::seconds(seconds)); };

    struct Candidate {
        std::string session_id;
        std::string project_id;
        std::string client;
        std::string client_session;
        std::optional<std::string> cwd;
        std::string seen_at;
        std::int64_t mark;
    };
    return database_.transaction([&] {
        if (limited && json(clients) != command_clients()) {
            store_text_setting(database_, "dispatch_clients", json(clients).dump());
        }
        // A start that never reported back is over, one way or the other.
        database_.execute(
            "UPDATE deliveries SET status = 'failed', detail = 'no result was reported' "
            "WHERE status = 'running' AND created_at <= ?",
            ago(kLostSeconds));

        std::vector<Candidate> candidates;
        Statement rows = database_.query(
            "SELECT h.session_id, s.project_id, h.client, h.client_session, h.cwd, h.seen_at, "
            "MAX(h.shown_rowid, h.urgent_rowid) FROM client_hooks h "
            "JOIN agent_sessions s ON s.session_id = h.session_id "
            "WHERE s.status = 'active' AND s.linked = 1 AND s.urgent_dispatch = 1 "
            "AND h.client_session IS NOT NULL AND h.client <> '' "
            // Idle: the last thing its client reported was the start of the conversation or the end of a turn.
            "AND h.event IN ('start', 'stop') AND h.seen_at <= ? "
            // A live watcher delivers by itself, inside the conversation.
            "AND (h.watch_seen_at IS NULL OR h.watch_seen_at < ?) "
            "ORDER BY h.session_id",
            ago(kSettleSeconds), ago(kWatchAliveSeconds));
        while (rows.step()) {
            candidates.push_back({rows.text(0), rows.text(1), rows.text(2), rows.text(3), rows.optional_text(4),
                                  rows.text(5), rows.integer(6)});
        }
        json jobs = json::array();
        for (const auto& candidate : candidates) {
            if (limited && std::ranges::find(clients, candidate.client) == clients.end()) {
                continue;
            }
            Statement history = database_.query(
                "SELECT "
                "(SELECT COUNT(*) FROM deliveries WHERE session_id = ?1 AND status = 'running'), "
                "(SELECT COUNT(*) FROM deliveries WHERE session_id = ?1 AND route = 'command' AND created_at > ?2), "
                // Failed starts since the client was last used, and whether the latest is recent.
                "(SELECT COUNT(*) FROM deliveries WHERE session_id = ?1 AND route = 'command' AND status = 'failed' "
                " AND created_at >= ?3), "
                "(SELECT COUNT(*) FROM deliveries WHERE session_id = ?1 AND route = 'command' AND status = 'failed' "
                " AND created_at > ?4), "
                "(SELECT COUNT(*) FROM deliveries WHERE session_id = ?1 AND route IN ('stop', 'watch', 'command') "
                " AND status <> 'failed' AND created_at > ?5)",
                candidate.session_id, ago(kMinIntervalSeconds), candidate.seen_at, ago(kRetrySeconds),
                ago(kWindowSeconds));
            history.step();
            if (history.integer(0) > 0 || history.integer(1) > 0 || history.integer(2) >= kMaxFailures ||
                history.integer(3) > 0 || history.integer(4) >= kMaxUrgentDeliveries) {
                continue;
            }
            std::vector<Pending> listed =
                pending(candidate.session_id, candidate.mark, candidate.mark, true, kMaxListed + 1);
            if (listed.empty()) {
                continue;
            }
            const bool cut = static_cast<std::int64_t>(listed.size()) > kMaxListed;
            if (cut) {
                listed.pop_back();
            }
            const std::int64_t upto = cut ? listed.back().rowid : last_rowid();
            database_.execute(
                "INSERT INTO deliveries (session_id, created_at, route, status, upto_rowid, messages, urgent) "
                "VALUES (?, ?, 'command', 'running', ?, ?, ?)",
                candidate.session_id, now, upto, static_cast<std::int64_t>(listed.size()),
                static_cast<std::int64_t>(listed.size()));
            jobs.push_back({{"delivery_id", database_.last_insert_rowid()},
                            {"session_id", candidate.session_id},
                            {"client", candidate.client},
                            {"client_session", candidate.client_session},
                            {"cwd", nullable(candidate.cwd)},
                            {"text", compose(listed, cut ? 1 : 0, "command")}});
        }
        return json{{"jobs", jobs}};
    });
}

json Delivery::report(const json& args) {
    const auto delivery_id = optional_integer(args, "delivery_id", 1, INT64_MAX);
    if (!delivery_id) {
        fail("INVALID_ARGUMENT", "delivery_id is required");
    }
    const bool ok = optional_bool(args, "ok", false);
    const auto detail = optional_string(args, "detail", 500);
    return database_.transaction([&] {
        Statement found = database_.query(
            "SELECT d.session_id, d.status, d.upto_rowid, d.messages, s.project_id FROM deliveries d "
            "JOIN agent_sessions s ON s.session_id = d.session_id WHERE d.delivery_id = ? AND d.route = 'command'",
            *delivery_id);
        if (!found.step()) {
            fail("NOT_FOUND", std::format("delivery {} does not exist", *delivery_id));
        }
        const auto session_id = found.text(0);
        const auto upto = found.integer(2);
        const auto messages = found.integer(3);
        const auto project_id = found.text(4);
        if (found.text(1) == "running") {
            database_.execute("UPDATE deliveries SET status = ?, detail = ? WHERE delivery_id = ?",
                              ok ? "ok" : "failed", detail, *delivery_id);
            if (ok) {
                // Delivered: the hooks need not show these again as urgent.
                // Not beyond the last message that exists: messages may have been deleted meanwhile.
                database_.execute(
                    "UPDATE client_hooks SET urgent_rowid = MIN(MAX(urgent_rowid, ?), "
                    "(SELECT COALESCE(MAX(rowid), 0) FROM messages)) WHERE session_id = ?",
                    upto, session_id);
            }
            events_.append("delivery.dispatched", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"ok", ok}, {"messages", messages}});
        }
        return view(session_id);
    });
}

json Delivery::list() {
    std::vector<std::string> ids;
    Statement rows = database_.query("SELECT session_id FROM client_hooks ORDER BY session_id");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json hooks = json::array();
    for (const auto& id : ids) {
        hooks.push_back(view(id));
    }
    return hooks;
}

json Delivery::view(std::string_view session_id) {
    Statement row = database_.query(
        "SELECT session_id, client, event, seen_at, client_session IS NOT NULL, cwd, runs, watch_seen_at "
        "FROM client_hooks WHERE session_id = ?",
        session_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("session {} has not run a hook", session_id));
    }
    json view = {{"session_id", row.text(0)},
                 {"client", row.text(1)},
                 {"event", row.text(2)},
                 {"seen_at", row.text(3)},
                 // Whether the client told us which of its conversations ran the hook; the id itself stays here.
                 {"knows_conversation", row.integer(4) != 0},
                 {"cwd", nullable(row.optional_text(5))},
                 {"runs", row.integer(6)},
                 {"watch_seen_at", nullable(row.optional_text(7))},
                 {"last_delivery", nullptr},
                 {"last_urgent", nullptr}};
    const auto latest = [&](const char* filter) -> json {
        Statement found = database_.query(
            std::format("SELECT created_at, route, status, messages, urgent, detail FROM deliveries "
                        "WHERE session_id = ? {} ORDER BY delivery_id DESC LIMIT 1",
                        filter),
            session_id);
        if (!found.step()) {
            return nullptr;
        }
        return {{"at", found.text(0)},        {"route", found.text(1)},  {"status", found.text(2)},
                {"messages", found.integer(3)}, {"urgent", found.integer(4)}, {"detail", nullable(found.optional_text(5))}};
    };
    view["last_delivery"] = latest("");
    view["last_urgent"] = latest("AND route IN ('stop', 'watch', 'command')");
    return view;
}

}  // namespace acm
