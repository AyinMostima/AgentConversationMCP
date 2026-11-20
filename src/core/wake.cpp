#include "wake.hpp"

#include <algorithm>
#include <format>

namespace acm {

namespace {

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

// The signal goes to the vendor's public entry point, so it must be encrypted.
// Plain http is for an address on this machine, which is what tests use.
bool acceptable_address(const std::string& url) {
    if (url.starts_with("https://") && url.size() > 8) {
        return true;
    }
    return url.starts_with("http://127.0.0.1:") || url.starts_with("http://127.0.0.1/") ||
           url.starts_with("http://localhost:") || url.starts_with("http://localhost/");
}

}  // namespace

json WakeHooks::set(std::string_view session_id, const json& args) {
    const auto url = require_string(args, "url", 2048);
    if (!acceptable_address(url) || url.find_first_of(" \t\r\n") != std::string::npos) {
        fail("INVALID_ARGUMENT", "url must be an https address (the POST address of the routine's webhook)");
    }
    const auto key = optional_string(args, "key", 512);
    return database_.transaction([&] {
        Statement session = database_.query("SELECT project_id FROM agent_sessions WHERE session_id = ?", session_id);
        if (!session.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        const auto project_id = session.text(0);
        Statement existing = database_.query("SELECT enabled, include_text FROM wake_hooks WHERE session_id = ?", session_id);
        const bool known = existing.step();
        const bool enabled = optional_bool(args, "enabled", known ? existing.integer(0) != 0 : true);
        const bool include_text = optional_bool(args, "include_text", known ? existing.integer(1) != 0 : false);
        if (!known && !key) {
            fail("INVALID_ARGUMENT", "key is required: the secret shown with the webhook address");
        }
        if (known) {
            database_.execute(
                "UPDATE wake_hooks SET url = ?, key = COALESCE(?, key), enabled = ?, include_text = ? WHERE session_id = ?",
                url, key, enabled, include_text, session_id);
        } else {
            database_.execute(
                "INSERT INTO wake_hooks (session_id, url, key, enabled, include_text) VALUES (?, ?, ?, ?, ?)", session_id,
                url, *key, enabled, include_text);
        }
        // The event records that a hook exists, not where it points or what its key is.
        events_.append("wake_hook.changed", {.project_id = project_id}, session_id,
                       {{"session_id", session_id}, {"enabled", enabled}});
        return view(session_id);
    });
}

json WakeHooks::remove(std::string_view session_id) {
    return database_.transaction([&] {
        Statement session = database_.query("SELECT project_id FROM agent_sessions WHERE session_id = ?", session_id);
        if (!session.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        const auto project_id = session.text(0);
        if (database_.execute("DELETE FROM wake_hooks WHERE session_id = ?", session_id) > 0) {
            events_.append("wake_hook.changed", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"removed", true}});
        }
        return json{{"session_id", session_id}, {"removed", true}};
    });
}

json WakeHooks::request_test(std::string_view session_id) {
    if (database_.execute("UPDATE wake_hooks SET test_requested = 1 WHERE session_id = ?", session_id) == 0) {
        fail("NOT_FOUND", std::format("session {} has no wake hook", session_id));
    }
    return view(session_id);
}

json WakeHooks::list() {
    std::vector<std::string> ids;
    Statement rows = database_.query("SELECT session_id FROM wake_hooks ORDER BY session_id");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json hooks = json::array();
    for (const auto& id : ids) {
        hooks.push_back(view(id));
    }
    return hooks;
}

json WakeHooks::find(std::string_view session_id) {
    if (!database_.query("SELECT 1 FROM wake_hooks WHERE session_id = ?", session_id).step()) {
        return nullptr;
    }
    return view(session_id);
}

json WakeHooks::claim() {
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    const auto listening_since = to_rfc3339(moment - std::chrono::seconds(kListeningSeconds));
    const auto interval_ago = to_rfc3339(moment - std::chrono::seconds(kMinIntervalSeconds));

    struct Candidate {
        std::string session_id;
        std::string project_id;
        std::string url;
        std::string key;
        bool test;
        bool include_text;
        std::int64_t requests;
        std::int64_t direct_messages;
        // Work that arrived after the previous signal, and what became of that signal.
        std::int64_t fresh;
        std::optional<std::string> last_attempt_at;
        std::optional<std::string> last_status;
        std::optional<std::string> last_detail;
        // Signals in a row that did not get through, counting back from the latest.
        std::int64_t failures;
    };
    return database_.transaction([&] {
        std::vector<Candidate> candidates;
        Statement rows = database_.query(
            "SELECT h.session_id, s.project_id, h.url, h.key, h.test_requested, h.include_text, "
            // Work that only this session can pick up.
            "(SELECT COUNT(*) FROM bot_requests r WHERE r.host_session_id = h.session_id AND r.status = 'queued'), "
            "(SELECT COUNT(*) FROM message_recipients mr JOIN messages m ON m.message_id = mr.message_id "
            " JOIN conversations c ON c.conversation_id = m.conversation_id "
            " JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.session_id = mr.session_id "
            " WHERE mr.session_id = h.session_id AND mr.status = 'available' AND c.kind = 'direct' "
            " AND c.status = 'open' AND cm.removed_at IS NULL), "
            // The part of it that the previous signal could not have announced.
            "(SELECT COUNT(*) FROM bot_requests r WHERE r.host_session_id = h.session_id AND r.status = 'queued' "
            " AND r.rowid > h.seen_request_rowid) + "
            "(SELECT COUNT(*) FROM message_recipients mr JOIN messages m ON m.message_id = mr.message_id "
            " JOIN conversations c ON c.conversation_id = m.conversation_id "
            " JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.session_id = mr.session_id "
            " WHERE mr.session_id = h.session_id AND mr.status = 'available' AND c.kind = 'direct' "
            " AND c.status = 'open' AND cm.removed_at IS NULL AND m.rowid > h.seen_message_rowid), "
            "h.last_attempt_at, h.last_status, h.last_detail, "
            "(SELECT COUNT(*) FROM wake_attempts a WHERE a.session_id = h.session_id AND a.status = 'failed' "
            " AND a.attempt_id > COALESCE((SELECT MAX(o.attempt_id) FROM wake_attempts o "
            " WHERE o.session_id = h.session_id AND o.status = 'ok'), 0)) "
            "FROM wake_hooks h JOIN agent_sessions s ON s.session_id = h.session_id "
            "WHERE h.enabled = 1 AND s.status = 'active' "
            // A session that is listening sees the work by itself.
            "AND (h.test_requested = 1 OR s.host_seen_at IS NULL OR s.host_seen_at < ?) "
            // Signals a moment apart are merged into one; the operator's own test does not wait.
            "AND (h.test_requested = 1 OR h.last_attempt_at IS NULL OR h.last_attempt_at <= ?) "
            "ORDER BY h.session_id",
            listening_since, interval_ago);
        while (rows.step()) {
            Candidate candidate{rows.text(0),          rows.text(1),          rows.text(2),          rows.text(3),
                                rows.integer(4) != 0,  rows.integer(5) != 0,  rows.integer(6),       rows.integer(7),
                                rows.integer(8),       rows.optional_text(9), rows.optional_text(10),
                                rows.optional_text(11), rows.integer(12)};
            // There is no cap on how often new work is announced. What is not
            // repeated is the same announcement: work the previous signal already
            // covered is announced again only after kRepeatSeconds. A signal that the
            // network swallowed was no announcement at all, so it is tried again much
            // sooner, a little less eagerly each time it fails.
            const bool lost = candidate.last_status == std::optional<std::string>("failed") &&
                              !candidate.last_detail.value_or("").starts_with("HTTP ");
            const std::int64_t doubling = std::min<std::int64_t>(std::max<std::int64_t>(candidate.failures, 1) - 1, 8);
            const std::int64_t wait = lost ? std::min(kRepeatSeconds, kRetryBaseSeconds << doubling) : kRepeatSeconds;
            const bool repeat_due = !candidate.last_attempt_at ||
                                    *candidate.last_attempt_at <= to_rfc3339(moment - std::chrono::seconds(wait));
            const bool waiting = candidate.requests + candidate.direct_messages > 0;
            if (candidate.test || (waiting && (candidate.fresh > 0 || repeat_due))) {
                candidates.push_back(std::move(candidate));
            }
        }
        json signals = json::array();
        for (const auto& candidate : candidates) {
            database_.execute(
                "INSERT INTO wake_attempts (session_id, created_at, reason, status) VALUES (?, ?, ?, 'sending')",
                candidate.session_id, now, candidate.test ? "test" : "work");
            const std::int64_t attempt_id = database_.last_insert_rowid();
            database_.execute(
                "UPDATE wake_hooks SET last_attempt_at = ?, last_status = 'sending', last_detail = NULL, "
                "test_requested = 0, "
                // Everything stored up to this point is covered by this signal.
                "seen_request_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM bot_requests), "
                "seen_message_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM messages) WHERE session_id = ?",
                now, candidate.session_id);
            // All that leaves this machine: that work waits, and how much.
            json body = {{"source", "acm"},
                         {"pending_requests", candidate.requests},
                         {"unread_direct_messages", candidate.direct_messages}};
            if (candidate.test) {
                body["test"] = true;
            }
            if (candidate.include_text && candidate.requests > 0) {
                // The instructions themselves, oldest first, so they show up in the
                // bot's own conversation. They are marked as carried by this signal.
                json carried = json::array();
                Statement queued = database_.query(
                    "SELECT r.request_id, r.action, r.bot, r.text, ra.display_name, rs.label FROM bot_requests r "
                    "JOIN agent_sessions rs ON rs.session_id = r.requester_session_id "
                    "JOIN agents ra ON ra.agent_id = rs.agent_id "
                    "WHERE r.host_session_id = ? AND r.status = 'queued' ORDER BY r.created_at, r.request_id LIMIT 5",
                    candidate.session_id);
                while (queued.step()) {
                    carried.push_back({{"request_id", queued.text(0)},
                                       {"action", queued.text(1)},
                                       {"bot", nullable(queued.optional_text(2))},
                                       {"text", nullable(queued.optional_text(3))},
                                       {"from", std::format("{} ({})", queued.text(4), queued.text(5))}});
                }
                for (const auto& request : carried) {
                    database_.execute("UPDATE bot_requests SET delivery_attempt_id = ? WHERE request_id = ?", attempt_id,
                                      request.at("request_id").get<std::string>());
                }
                body["requests"] = std::move(carried);
            }
            signals.push_back({{"attempt_id", attempt_id},
                               {"session_id", candidate.session_id},
                               {"url", candidate.url},
                               {"key", candidate.key},
                               {"body", body}});
        }
        return json{{"signals", signals}};
    });
}

json WakeHooks::report(const json& args) {
    const auto attempt_id = optional_integer(args, "attempt_id", 1, INT64_MAX);
    if (!attempt_id) {
        fail("INVALID_ARGUMENT", "attempt_id is required");
    }
    const bool ok = optional_bool(args, "ok", false);
    const auto http_status = optional_integer(args, "http_status", 0, 999);
    const auto detail = optional_string(args, "detail", 500);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement found = database_.query(
            "SELECT a.session_id, a.status, s.project_id FROM wake_attempts a "
            "JOIN agent_sessions s ON s.session_id = a.session_id WHERE a.attempt_id = ?",
            *attempt_id);
        if (!found.step()) {
            fail("NOT_FOUND", std::format("wake attempt {} does not exist", *attempt_id));
        }
        const auto session_id = found.text(0);
        const auto project_id = found.text(2);
        if (found.text(1) == "sending") {
            const std::string status = ok ? "ok" : "failed";
            database_.execute("UPDATE wake_attempts SET status = ?, http_status = ?, detail = ? WHERE attempt_id = ?",
                              status, http_status, detail, *attempt_id);
            database_.execute(
                "UPDATE wake_hooks SET last_status = ?, last_detail = ?, last_ok_at = CASE WHEN ? THEN ? ELSE "
                "last_ok_at END WHERE session_id = ?",
                status, detail, ok, now, session_id);
            // What the signal carried: accepted means the bot has it, refused means it is still waiting.
            if (ok) {
                std::vector<std::string> delivered;
                Statement carried = database_.query(
                    "SELECT request_id FROM bot_requests WHERE delivery_attempt_id = ? AND status = 'queued'",
                    *attempt_id);
                while (carried.step()) {
                    delivered.push_back(carried.text(0));
                }
                for (const auto& request_id : delivered) {
                    database_.execute("UPDATE bot_requests SET status = 'taken', taken_at = ? WHERE request_id = ?", now,
                                      request_id);
                    events_.append("bot_request.taken", {.project_id = project_id, .actor_id = session_id}, request_id,
                                   {{"request_id", request_id}, {"delivered_by", "wake_hook"}});
                }
            } else {
                database_.execute("UPDATE bot_requests SET delivery_attempt_id = NULL WHERE delivery_attempt_id = ?",
                                  *attempt_id);
            }
            events_.append("wake.sent", {.project_id = project_id}, session_id,
                           {{"session_id", session_id},
                            {"ok", ok},
                            {"http_status", http_status ? json(*http_status) : json(nullptr)}});
        }
        return view(session_id);
    });
}

json WakeHooks::view(std::string_view session_id) {
    Statement row = database_.query(
        "SELECT h.session_id, h.url, h.enabled, h.last_attempt_at, h.last_status, h.last_detail, h.last_ok_at, "
        "h.test_requested, (SELECT COUNT(*) FROM wake_attempts a WHERE a.session_id = h.session_id), h.include_text "
        "FROM wake_hooks h WHERE h.session_id = ?",
        session_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("session {} has no wake hook", session_id));
    }
    return {{"session_id", row.text(0)},
            {"url", row.text(1)},
            {"enabled", row.integer(2) != 0},
            {"has_key", true},
            {"last_attempt_at", nullable(row.optional_text(3))},
            {"last_status", nullable(row.optional_text(4))},
            {"last_detail", nullable(row.optional_text(5))},
            {"last_ok_at", nullable(row.optional_text(6))},
            {"test_requested", row.integer(7) != 0},
            {"attempts", row.integer(8)},
            {"include_text", row.integer(9) != 0}};
}

}  // namespace acm
