#include "bot_control.hpp"

#include "settings.hpp"

#include <algorithm>
#include <array>
#include <format>

namespace acm {

namespace {

constexpr std::size_t kMaxTextBytes = 16 * 1024;
constexpr std::size_t kMaxResultBytes = 64 * 1024;

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

struct ActionRule {
    std::string_view name;
    bool needs_bot;
    bool needs_text;
};

// The closed list of what one session may ask of a bot host.
constexpr std::array<ActionRule, 5> kActions = {{
    {"ask", false, true},
    {"list_bots", false, false},
    {"create_bot", true, false},
    {"send_to_bot", true, true},
    {"get_transcript", true, false},
}};

bool contains_any(const std::string& haystack, std::initializer_list<std::string_view> needles) {
    return std::ranges::any_of(needles, [&](std::string_view needle) { return haystack.contains(needle); });
}

std::string lowered(std::string text) {
    std::ranges::transform(text, text.begin(), [](unsigned char c) {
        return c < 0x80 ? static_cast<char>(std::tolower(c)) : static_cast<char>(c);
    });
    return text;
}

// The removal verbs, in English and as UTF-8 bytes of their Chinese forms
// (shan-chu, shan-diao, yi-chu, xiao-hui, qing-kong, zhu-xiao, gan-diao).
bool has_removal_verb(const std::string& text) {
    return contains_any(text, {"delete", "remove", "destroy", "erase", "wipe out", "get rid of", "terminate",
                               "\xe5\x88\xa0\xe9\x99\xa4", "\xe5\x88\xa0\xe6\x8e\x89", "\xe7\xa7\xbb\xe9\x99\xa4",
                               "\xe9\x94\x80\xe6\xaf\x81", "\xe6\xb8\x85\xe7\xa9\xba", "\xe6\xb3\xa8\xe9\x94\x80",
                               "\xe5\xb9\xb2\xe6\x8e\x89"});
}

// Words for what must not be removed: bot, agent, yourself, and the Chinese
// ji-qi-ren, zhu-shou, dai-li, zi-ji.
bool names_a_bot(const std::string& text) {
    return contains_any(text, {"bot", "agent", "yourself", "\xe6\x9c\xba\xe5\x99\xa8\xe4\xba\xba",
                               "\xe5\x8a\xa9\xe6\x89\x8b", "\xe4\xbb\xa3\xe7\x90\x86", "\xe8\x87\xaa\xe5\xb7\xb1"});
}

// Wording that asks for a bot to be removed: a removal verb together with a
// word for a bot. A screen for the obvious cases, not a proof; the host is told
// separately never to remove a bot because a request said so.
bool asks_for_removal(const std::optional<std::string>& text) {
    const std::string words = lowered(text.value_or(""));
    return has_removal_verb(words) && names_a_bot(words);
}

}  // namespace

json BotControl::request(const Session& session, const json& args) {
    const auto action = require_string(args, "action", 32);
    const auto rule = std::ranges::find(kActions, action, &ActionRule::name);
    if (rule == kActions.end()) {
        const std::string wanted = lowered(action);
        if (has_removal_verb(wanted) || wanted.contains("archive")) {
            fail("ACTION_NOT_ALLOWED",
                 "deleting or removing a bot is not available here; only the operator can do that, in the bot's own "
                 "application",
                 {{"action", action}});
        }
        fail("ACTION_NOT_ALLOWED",
             std::format("action {} is not available; use ask, list_bots, create_bot, send_to_bot or get_transcript",
                         action),
             {{"action", action}});
    }
    const auto bot = optional_string(args, "bot", 200);
    const auto text = optional_string(args, "text", kMaxTextBytes);
    if (rule->needs_bot && !bot) {
        fail("INVALID_ARGUMENT", std::format("action {} needs bot: the name of the bot it is about", action));
    }
    if (rule->needs_text && !text) {
        fail("INVALID_ARGUMENT", std::format("action {} needs text: what the bot should do", action));
    }
    const auto wanted_host = optional_string(args, "host_session_id", 96);
    const auto key = require_string(args, "idempotency_key", 128);
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);

    return database_.transaction([&] {
        Statement prior = database_.query(
            "SELECT request_id FROM bot_requests WHERE requester_session_id = ? AND idempotency_key = ?",
            session.session_id, key);
        if (prior.step()) {
            json existing = row(prior.text(0));
            existing["idempotent_replay"] = true;
            return existing;
        }

        std::string host;
        if (wanted_host) {
            Statement target = database_.query(
                "SELECT project_id, status FROM agent_sessions WHERE session_id = ?", *wanted_host);
            if (!target.step() || target.text(0) != session.project_id || target.text(1) != "active") {
                fail("INVALID_RECIPIENT",
                     std::format("session {} is not an approved session of this project", *wanted_host),
                     {{"session_id", *wanted_host}});
            }
            host = *wanted_host;
        } else {
            // The session that has been serving requests; before any has, the xAI session of the project.
            std::vector<std::string> candidates;
            Statement serving = database_.query(
                "SELECT session_id FROM agent_sessions WHERE project_id = ? AND status = 'active' AND "
                "host_seen_at IS NOT NULL ORDER BY host_seen_at DESC",
                session.project_id);
            while (serving.step()) {
                candidates.push_back(serving.text(0));
            }
            if (candidates.empty()) {
                Statement likely = database_.query(
                    "SELECT s.session_id FROM agent_sessions s JOIN agents a ON a.agent_id = s.agent_id "
                    "WHERE s.project_id = ? AND s.status = 'active' AND a.provider = 'xai'",
                    session.project_id);
                while (likely.step()) {
                    candidates.push_back(likely.text(0));
                }
            }
            if (candidates.size() != 1) {
                fail("NO_BOT_HOST",
                     candidates.empty()
                         ? "no session of this project serves bot requests yet; the bot host has to connect and "
                           "listen first"
                         : "more than one session serves bot requests; say which with host_session_id",
                     {{"candidates", candidates}});
            }
            host = candidates.front();
        }
        if (host == session.session_id) {
            fail("INVALID_ARGUMENT", "a session cannot send a bot request to itself");
        }
        if (!session.rate_exempt) {
            enforce_rate(database_, "bot_requests", "requester_session_id", session.session_id, moment, "bot requests");
        }

        const bool held = asks_for_removal(text);
        const auto request_id = new_id("brq");
        database_.execute(
            "INSERT INTO bot_requests (request_id, project_id, requester_session_id, host_session_id, action, bot, "
            "text, status, hold_reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            request_id, session.project_id, session.session_id, host, action, bot, text, held ? "held" : "queued",
            held ? std::optional<std::string>("asks for a bot to be deleted or removed") : std::nullopt, key, now);
        // Like message events, this one says that something was asked, never what.
        events_.append("bot_request.created", {.project_id = session.project_id, .actor_id = session.session_id},
                       request_id,
                       {{"request_id", request_id},
                        {"action", action},
                        {"status", held ? "held" : "queued"},
                        {"host_session_id", host}});
        json created = row(request_id);
        created["idempotent_replay"] = false;
        return created;
    });
}

json BotControl::list(const Session& session, const json& args) {
    const auto limit = optional_integer(args, "limit", 20, 1, 100);
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT request_id FROM bot_requests WHERE requester_session_id = ? ORDER BY created_at DESC, request_id "
        "LIMIT ?",
        session.session_id, limit);
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json requests = json::array();
    for (const auto& id : ids) {
        requests.push_back(row(id));
    }
    database_.execute(
        "UPDATE bot_requests SET seen_by_requester = 1 WHERE requester_session_id = ? AND status IN ('done', "
        "'failed', 'rejected')",
        session.session_id);
    return {{"requests", requests}};
}

json BotControl::pull(const Session& session, const json& args) {
    const auto limit = optional_integer(args, "limit", 5, 1, 20);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        database_.execute("UPDATE agent_sessions SET host_seen_at = ? WHERE session_id = ?", now, session.session_id);
        std::vector<std::string> unfinished;
        Statement open = database_.query(
            "SELECT request_id FROM bot_requests WHERE host_session_id = ? AND status = 'taken' ORDER BY taken_at, "
            "request_id",
            session.session_id);
        while (open.step()) {
            unfinished.push_back(open.text(0));
        }
        std::vector<std::string> fresh;
        Statement queued = database_.query(
            "SELECT request_id FROM bot_requests WHERE host_session_id = ? AND status = 'queued' ORDER BY "
            "created_at, request_id LIMIT ?",
            session.session_id, limit);
        while (queued.step()) {
            fresh.push_back(queued.text(0));
        }
        for (const auto& id : fresh) {
            database_.execute("UPDATE bot_requests SET status = 'taken', taken_at = ? WHERE request_id = ?", now, id);
            events_.append("bot_request.taken", {.project_id = session.project_id, .actor_id = session.session_id},
                           id, {{"request_id", id}});
        }
        json result = {{"requests", json::array()}, {"unfinished", json::array()}};
        for (const auto& id : fresh) {
            result["requests"].push_back(row(id));
        }
        for (const auto& id : unfinished) {
            result["unfinished"].push_back(row(id));
        }
        Statement waiting = database_.query(
            "SELECT COUNT(*) FROM bot_requests WHERE host_session_id = ? AND status = 'queued'", session.session_id);
        waiting.step();
        result["still_queued"] = waiting.integer(0);
        return result;
    });
}

json BotControl::respond(const Session& session, const json& args) {
    const auto request_id = require_string(args, "request_id", 96);
    const auto result = require_string(args, "result", kMaxResultBytes);
    const bool ok = optional_bool(args, "ok", true);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement found = database_.query(
            "SELECT host_session_id, status FROM bot_requests WHERE request_id = ?", request_id);
        // A request that is someone else's is reported like one that does not exist.
        if (!found.step() || found.text(0) != session.session_id) {
            fail("NOT_FOUND", std::format("bot request {} is not addressed to this session", request_id));
        }
        const auto status = found.text(1);
        if (status == "done" || status == "failed") {
            json existing = row(request_id);
            existing["already_answered"] = true;
            return existing;
        }
        if (status != "taken" && status != "queued") {
            fail("REQUEST_CLOSED", std::format("bot request {} is {} and cannot be answered", request_id, status));
        }
        database_.execute(
            "UPDATE bot_requests SET status = ?, result = ?, finished_at = ?, taken_at = COALESCE(taken_at, ?) "
            "WHERE request_id = ?",
            ok ? "done" : "failed", result, now, now, request_id);
        events_.append("bot_request.finished", {.project_id = session.project_id, .actor_id = session.session_id},
                       request_id, {{"request_id", request_id}, {"status", ok ? "done" : "failed"}});
        json answered = row(request_id);
        answered["already_answered"] = false;
        return answered;
    });
}

json BotControl::news(const Session& session) {
    std::vector<std::string> finished;
    Statement rows = database_.query(
        "SELECT request_id FROM bot_requests WHERE requester_session_id = ? AND seen_by_requester = 0 AND "
        "status IN ('done', 'failed', 'rejected') ORDER BY finished_at, request_id",
        session.session_id);
    while (rows.step()) {
        finished.push_back(rows.text(0));
    }
    json results = json::array();
    for (const auto& id : finished) {
        results.push_back(row(id));
        database_.execute("UPDATE bot_requests SET seen_by_requester = 1 WHERE request_id = ?", id);
    }
    Statement waiting = database_.query(
        "SELECT COUNT(*) FROM bot_requests WHERE host_session_id = ? AND status = 'queued'", session.session_id);
    waiting.step();
    return {{"results", results}, {"waiting_for_you", waiting.integer(0)}};
}

json BotControl::admin_list() {
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT request_id FROM bot_requests ORDER BY status = 'held' DESC, created_at DESC, request_id LIMIT 50");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json requests = json::array();
    for (const auto& id : ids) {
        requests.push_back(row(id));
    }
    return requests;
}

json BotControl::decide(std::string_view request_id, bool approve) {
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement found = database_.query("SELECT status, project_id FROM bot_requests WHERE request_id = ?",
                                          request_id);
        if (!found.step()) {
            fail("NOT_FOUND", std::format("bot request {} does not exist", request_id));
        }
        if (found.text(0) == "held") {
            const auto project_id = found.text(1);
            if (approve) {
                database_.execute("UPDATE bot_requests SET status = 'queued' WHERE request_id = ?", request_id);
            } else {
                database_.execute(
                    "UPDATE bot_requests SET status = 'rejected', finished_at = ?, result = ? WHERE request_id = ?",
                    now, "The operator did not release this request.", request_id);
            }
            events_.append("bot_request.decided", {.project_id = project_id}, request_id,
                           {{"request_id", request_id}, {"status", approve ? "queued" : "rejected"}});
        }
        return row(request_id);
    });
}

json BotControl::row(std::string_view request_id) {
    Statement found = database_.query(
        "SELECT r.request_id, r.action, r.bot, r.text, r.status, r.hold_reason, r.result, r.created_at, r.taken_at, "
        "r.finished_at, r.requester_session_id, rs.label, ra.display_name, r.host_session_id, hs.label, "
        "ha.display_name, hs.host_seen_at, r.project_id "
        "FROM bot_requests r "
        "JOIN agent_sessions rs ON rs.session_id = r.requester_session_id JOIN agents ra ON ra.agent_id = rs.agent_id "
        "JOIN agent_sessions hs ON hs.session_id = r.host_session_id JOIN agents ha ON ha.agent_id = hs.agent_id "
        "WHERE r.request_id = ?",
        request_id);
    if (!found.step()) {
        fail("NOT_FOUND", std::format("bot request {} does not exist", request_id));
    }
    return {{"request_id", found.text(0)},
            {"action", found.text(1)},
            {"bot", nullable(found.optional_text(2))},
            {"text", nullable(found.optional_text(3))},
            {"status", found.text(4)},
            {"hold_reason", nullable(found.optional_text(5))},
            {"result", nullable(found.optional_text(6))},
            {"created_at", found.text(7)},
            {"taken_at", nullable(found.optional_text(8))},
            {"finished_at", nullable(found.optional_text(9))},
            {"requester",
             {{"session_id", found.text(10)}, {"label", found.text(11)}, {"display_name", found.text(12)}}},
            {"host",
             {{"session_id", found.text(13)},
              {"label", found.text(14)},
              {"display_name", found.text(15)},
              // When the host last asked for requests; null means it has never listened.
              {"last_listened_at", nullable(found.optional_text(16))}}},
            {"project_id", found.text(17)}};
}

}  // namespace acm
