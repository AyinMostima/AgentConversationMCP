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
    return event == "start" || event == "prompt" || event == "stop" || event == "watch" || event == "tool";
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

// What a vendor's command says when the conversation it was given cannot be continued at all.
bool says_gone(std::string_view detail) {
    for (const char* sign : {"no rollout found", "thread not found", "unknown thread", "session not found"}) {
        if (detail.find(sign) != std::string_view::npos) {
            return true;
        }
    }
    return false;
}

}  // namespace

std::vector<Delivery::Pending> Delivery::pending(std::string_view session_id, std::string_view window_id,
                                                 std::int64_t floor, bool urgent_only, std::int64_t limit) {
    std::vector<Pending> found;
    // What this window has not read, counted from its own place (see Windows::resolve
    // for where that starts). Not what it wrote
    // itself; what another window of its session wrote only when the two can be
    // told apart. With target windows, only when it is one of them.
    Statement rows = database_.query(
        "SELECT m.rowid, m.message_id, m.body, m.urgent, m.created_at, m.sender_kind, a.display_name, s.label, "
        "c.kind, c.title, aw.name, "
        "EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id AND t.window_id = ?2), "
        "m.directed, EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id), "
        "COALESCE(m.sender_session_id, '') = ?1 "
        "FROM messages m "
        "JOIN conversations c ON c.conversation_id = m.conversation_id AND c.status = 'open' "
        "JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.session_id = ?1 "
        "LEFT JOIN window_cursors wc ON wc.window_id = ?2 AND wc.conversation_id = m.conversation_id "
        "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
        "LEFT JOIN agents a ON a.agent_id = s.agent_id "
        "LEFT JOIN windows aw ON aw.window_id = m.author_window_id "
        "WHERE cm.removed_at IS NULL AND cm.can_read = 1 AND m.seq > COALESCE(wc.read_seq, 0) "
        "AND COALESCE(m.author_window_id, '') <> ?2 "
        "AND NOT (m.author_window_id IS NULL AND COALESCE(m.sender_session_id, '') = ?1) "
        "AND (m.directed = 0 OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id "
        "AND r.session_id = ?1)) "
        "AND (NOT EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id) "
        " OR EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id AND t.window_id = ?2)) "
        "AND m.kind IN ('message', 'handoff', 'decision') "
        "AND m.rowid > ?3 AND (?4 = 0 OR m.urgent = 1) "
        // What a digest of the conversation covers is not listed message by message any
        // more, unless compacting kept it; what compacting dropped is not listed at all.
        "AND m.context >= 0 AND (m.seq > c.digest_seq OR m.context = 1) "
        // A direct conversation belongs to the windows of this session that write in it:
        // the others are not shown its traffic. When none of them can be told (nobody of
        // this session wrote there from a known window), every window sees it.
        "AND (c.kind <> 'direct' "
        " OR EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id AND t.window_id = ?2) "
        " OR EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = m.conversation_id AND o.author_window_id = ?2) "
        " OR NOT EXISTS (SELECT 1 FROM messages o JOIN windows ow ON ow.window_id = o.author_window_id "
        "                WHERE o.conversation_id = m.conversation_id AND ow.session_id = ?1)) "
        // Not what an urgent route already put in front of this window (or is handing to
        // its client this moment): each such delivery covered the urgent messages of a range.
        "AND NOT (m.urgent = 1 AND EXISTS (SELECT 1 FROM deliveries d WHERE d.window_id = ?2 "
        " AND d.route IN ('stop', 'watch', 'command', 'tool') AND d.status IN ('running', 'ok') AND d.stand_in = 0 "
        " AND d.from_rowid IS NOT NULL AND m.rowid > d.from_rowid AND m.rowid <= d.upto_rowid)) "
        "ORDER BY m.rowid LIMIT ?5",
        session_id, window_id, floor, urgent_only, limit);
    while (rows.step()) {
        std::string from;
        if (rows.text(5) == "operator") {
            from = "the operator (console)";
        } else if (const auto author = rows.optional_text(10)) {
            // The application and which of its windows.
            from = std::format("{} window \"{}\"", rows.optional_text(6).value_or("unknown"), *author);
        } else {
            from = std::format("{} ({})", rows.optional_text(6).value_or("unknown"), rows.optional_text(7).value_or("?"));
        }
        const std::string kind = rows.text(8);
        const std::string where = kind == "lobby"    ? std::string("the lobby")
                                  : kind == "direct" ? std::string("a direct conversation with you")
                                                     : std::format("\"{}\"", rows.text(9));
        found.push_back({rows.integer(0), rows.text(1), rows.text(2), rows.integer(3) != 0, rows.text(4), from, where,
                         rows.integer(11) != 0,
                         // Without target windows, and either directed at this session or in its direct conversation.
                         rows.integer(13) == 0 && (rows.integer(12) != 0 || kind == "direct"),
                         rows.integer(14) != 0});
    }
    return found;
}

std::vector<Delivery::Pending> Delivery::interrupting(std::string_view session_id, std::string_view window_id,
                                                      std::int64_t floor) {
    std::vector<Pending> found = pending(session_id, window_id, floor, true, 500);
    if (found.empty()) {
        return found;
    }
    Statement self = database_.query("SELECT imported FROM windows WHERE window_id = ?", window_id);
    // A window that is only known from its client's record stands for no session: it is started when named.
    const bool recorded = self.step() && self.integer(0) != 0;
    Statement front = database_.query(
        "SELECT window_id FROM windows WHERE session_id = ? AND addressable = 1 AND imported = 0 "
        "ORDER BY seen_at DESC, window_id LIMIT 1",
        session_id);
    const bool latest = !recorded && front.step() && front.text(0) == window_id;
    std::erase_if(found, [&](const Pending& entry) {
        if (entry.to_you) {
            return false;
        }
        if (!latest || !entry.personal || entry.own) {
            return true;
        }
        // For the session as such: one of its windows deals with it, not each in turn.
        return database_
            .query("SELECT 1 FROM deliveries WHERE session_id = ? AND window_id <> ? "
                   "AND route IN ('stop', 'watch', 'command', 'tool') AND status IN ('running', 'ok') "
                   "AND from_rowid IS NOT NULL AND ? > from_rowid AND ? <= upto_rowid",
                   session_id, window_id, entry.rowid, entry.rowid)
            .step();
    });
    return found;
}

std::int64_t Delivery::last_rowid() {
    Statement row = database_.query("SELECT COALESCE(MAX(rowid), 0) FROM messages");
    row.step();
    return row.integer(0);
}

std::string Delivery::compose(const std::vector<Pending>& listed, std::int64_t more, std::string_view route,
                              std::string_view window_name) {
    if (listed.empty()) {
        return {};
    }
    const bool interrupting = route == "stop" || route == "watch" || route == "command" || route == "tool";
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
            "conversation.";
    // How others address this conversation, so it can say so and recognise itself.
    text += std::format(" This conversation is window \"{}\".\n", window_name);
    int number = 0;
    std::size_t left = kHookBytes;
    for (const auto& entry : listed) {
        const std::size_t allowance = entry.urgent ? kUrgentBodyBytes : entry.to_you || entry.personal ? kBodyBytes : kBriefBytes;
        const std::size_t allowed = std::min(allowance, std::max(left, kLeastBytes));
        left -= std::min(left, std::min(entry.body.size(), allowed));
        text += std::format("\n{}. {}{} in {}{}, {}:\n{}\n", ++number, entry.urgent ? "[URGENT] " : "", entry.from,
                            entry.where, entry.to_you ? ", addressed to this window" : "", entry.created_at,
                            clip(entry.body, allowed));
    }
    text += "\n";
    if (more > 0 && interrupting) {
        text += std::format("{} more are waiting and are not listed here. ", more);
    } else if (more > 0) {
        text += std::format("{} earlier one(s) are not listed here: check_in gives the newest of each conversation and "
                            "a digest of what came before. ", more);
    }
    if (interrupting) {
        text += "Deal with them now: call the acm check_in tool, do what they ask as far as your user's instructions "
                "for this conversation allow, and report back with send_message or direct_message. Mark your answer "
                "urgent only if it cannot wait either.";
    } else {
        text += "Call the acm check_in tool to mark them read and to see the task board; answer with send_message "
                "or direct_message where an answer is needed.";
    }
    if (route == "command") {
        text += " This turn was started by ACM while the conversation was idle, on behalf of the sender, who is a "
                "colleague and not your user.";
    }
    return text;
}

json Delivery::hook(const Session& session, const json& args) {
    const auto event = require_string(args, "event", 16);
    if (!is_event(event)) {
        fail("INVALID_ARGUMENT", "event must be start, prompt, stop, watch or tool");
    }
    const auto client = optional_string(args, "client", 32);
    const auto client_session = optional_string(args, "client_session", 256);
    const auto cwd = optional_string(args, "cwd", 1024);
    const auto watch_id = optional_string(args, "watch_id", 64);
    const bool peek = optional_bool(args, "peek", false);
    // Whether the client keeps this conversation, when the hook can tell. One it does
    // not keep (a helper thread) cannot be continued later: nobody addresses or wakes it.
    const std::optional<bool> persistent =
        args.contains("persistent") && args.at("persistent").is_boolean()
            ? std::optional<bool>(args.at("persistent").get<bool>())
            : std::nullopt;
    const bool urgent_only = event != "start" && event != "prompt";
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    if (event == "watch" && !watch_id) {
        fail("INVALID_ARGUMENT", "watch_id is required for the watch event");
    }

    return database_.transaction([&] {
        // A client that does not say which conversation this is has one window, as far as we can tell.
        const Window window = *windows_.resolve(session, client, client_session && !client_session->empty()
                                                                     ? client_session
                                                                     : std::optional<std::string>("-"),
                                                cwd);
        json result = {{"session_id", session.session_id},
                       {"window", {{"window_id", window.window_id}, {"name", window.name}}},
                       {"event", event},
                       {"superseded", false},
                       {"count", 0},
                       {"urgent", 0},
                       {"more", 0},
                       {"text", ""},
                       {"messages", json::array()}};
        if (event == "watch") {
            Statement current = database_.query("SELECT watch_id FROM windows WHERE window_id = ?", window.window_id);
            current.step();
            // One watcher per window: a newer one of the same conversation takes over.
            if (!optional_bool(args, "fresh", false) && current.optional_text(0) != watch_id) {
                result["superseded"] = true;
                return result;
            }
            database_.execute("UPDATE windows SET watch_seen_at = ?, watch_id = ? WHERE window_id = ?", now, *watch_id,
                              window.window_id);
        } else if (!peek) {
            // A tool call happens inside a turn: the window is in one, as after a prompt.
            database_.execute(
                "UPDATE windows SET event = ?, seen_at = ?, runs = runs + 1, hooked = 1, "
                "client = CASE WHEN ? IS NULL OR ? = '' THEN client ELSE ? END, cwd = COALESCE(?, cwd) "
                "WHERE window_id = ?",
                event == "tool" ? std::string("prompt") : event, now, client, client, client, cwd, window.window_id);
        }
        windows_.note_model(session, &window, optional_string(args, "model", 200), optional_string(args, "model_since", 40));
        if (persistent) {
            database_.execute("UPDATE windows SET addressable = ? WHERE window_id = ?",
                              static_cast<std::int64_t>(*persistent ? 1 : 0), window.window_id);
        }
        if (session.status != "active") {
            return result;
        }

        Statement marks = database_.query("SELECT shown_rowid, urgent_rowid FROM windows WHERE window_id = ?",
                                          window.window_id);
        marks.step();
        const std::int64_t shown = marks.integer(0);
        const std::int64_t urgent_mark = std::max(shown, marks.integer(1));
        if (urgent_only) {
            // The guard against windows interrupting each other without end.
            Statement recent = database_.query(
                "SELECT COUNT(*) FROM deliveries WHERE window_id = ? AND route IN ('stop', 'watch', 'command', 'tool') "
                "AND status NOT IN ('failed', 'skipped') AND created_at > ?",
                window.window_id, to_rfc3339(moment - std::chrono::seconds(kWindowSeconds)));
            recent.step();
            if (recent.integer(0) >= kMaxUrgentDeliveries) {
                result["held"] = true;
                return result;
            }
        }
        // The prompt route lists everything unread it has not listed itself, except what
        // an urgent route delivered to this window meanwhile (see pending): the model has
        // that in front of it already. Until it is read, check_in still reports it.
        const std::int64_t floor = urgent_only ? urgent_mark : shown;
        // An urgent route interrupts: only for what names this window (see interrupting).
        std::vector<Pending> listed = urgent_only
                                          ? interrupting(session.session_id, window.window_id, floor)
                                          : pending(session.session_id, window.window_id, floor, false, 1000);
        bool cut = static_cast<std::int64_t>(listed.size()) > kMaxListed;
        std::int64_t more = 0;
        if (cut && urgent_only) {
            more = static_cast<std::int64_t>(listed.size()) - kMaxListed;
            listed.resize(static_cast<std::size_t>(kMaxListed));
        } else if (cut) {
            // A window that is far behind is shown the newest, not its backlog from the oldest
            // end, prompt after prompt: what is old is history by now, and check_in has it as a
            // digest. Everything counts as looked at; what was addressed to the window and is
            // not among the newest comes back as a reminder until it is answered.
            more = static_cast<std::int64_t>(listed.size()) - kMaxListed;
            listed.erase(listed.begin(), listed.end() - kMaxListed);
            cut = false;
        }
        const auto urgent = std::ranges::count_if(listed, [](const Pending& entry) { return entry.urgent; });
        json messages = json::array();
        for (const auto& entry : listed) {
            messages.push_back({{"message_id", entry.message_id},
                                {"from", entry.from},
                                {"in", entry.where},
                                {"urgent", entry.urgent},
                                {"to_this_window", entry.to_you},
                                {"sent_at", entry.created_at}});
        }
        result["count"] = listed.size();
        result["urgent"] = urgent;
        result["more"] = more;
        // What is for this window comes first in what it is shown: its name on the message,
        // its session alone, its direct conversation. The rest keeps its order.
        std::vector<Pending> ordered = listed;
        if (!urgent_only) {
            std::ranges::stable_partition(ordered, [](const Pending& entry) { return entry.to_you || entry.personal; });
        }
        result["text"] = compose(ordered, more, event, window.name);
        // Messages addressed to this window that have gone unanswered for a while: a short
        // reminder in front of everything else, at most every kReminderSeconds. What only
        // just arrived is in front of the window as it is.
        if (!urgent_only) {
            std::vector<std::string> waiting =
                windows_.waiting_ids(session.session_id, window.window_id, kReminderListed + 1, kReminderSeconds);
            // Not the ones this very hook lists as new.
            std::erase_if(waiting, [&](const std::string& id) {
                return std::ranges::any_of(listed, [&](const Pending& entry) { return entry.message_id == id; });
            });
            Statement last = database_.query("SELECT reminded_at FROM windows WHERE window_id = ?", window.window_id);
            last.step();
            const bool due = last.optional_text(0).value_or("") <= to_rfc3339(moment - std::chrono::seconds(kReminderSeconds));
            if (!waiting.empty() && due) {
                const bool more_waiting = static_cast<std::int64_t>(waiting.size()) > kReminderListed;
                if (more_waiting) {
                    waiting.pop_back();
                }
                std::string block = std::format(
                    "[ACM] {}{} message(s) addressed to this conversation still wait for an answer. Answer them before "
                    "other work: reply where each was sent, or call the acm acknowledge_message tool with its id when no "
                    "reply is needed. check_in lists them in full under awaiting_your_reply.",
                    more_waiting ? "More than " : "", waiting.size());
                // Oldest first.
                for (auto id = waiting.rbegin(); id != waiting.rend(); ++id) {
                    Statement row = database_.query(
                        "SELECT m.body, m.created_at, m.sender_kind, a.display_name, aw.name, c.kind, c.title "
                        "FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id "
                        "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
                        "LEFT JOIN agents a ON a.agent_id = s.agent_id "
                        "LEFT JOIN windows aw ON aw.window_id = m.author_window_id WHERE m.message_id = ?",
                        *id);
                    if (!row.step()) {
                        continue;
                    }
                    const std::string from = row.text(2) == "operator" ? std::string("the operator (console)")
                                             : row.optional_text(4)
                                                   ? std::format("{} window \"{}\"", row.optional_text(3).value_or("unknown"), *row.optional_text(4))
                                                   : row.optional_text(3).value_or("unknown");
                    const std::string kind = row.text(5);
                    const std::string where = kind == "lobby"    ? std::string("the lobby")
                                              : kind == "direct" ? std::string("a direct conversation with you")
                                                                 : std::format("\"{}\"", row.text(6));
                    block += std::format("\n- {} in {}, {} ({}): {}", from, where, row.text(1), *id,
                                         clip(row.text(0), kReminderBytes));
                }
                const std::string rest = result.at("text").get<std::string>();
                result["text"] = rest.empty() ? block : block + "\n\n" + rest;
                result["waiting"] = waiting.size();
                if (!peek) {
                    database_.execute("UPDATE windows SET reminded_at = ? WHERE window_id = ?", now, window.window_id);
                }
            }
        }
        // A conversation that was summarized since this window last read it: the digest is
        // put in front of the window once, in place of the messages it covers.
        if (!urgent_only) {
            Statement due = database_.query(
                "SELECT c.conversation_id, c.kind, c.title, c.digest, c.digest_seq, c.digest_by, c.digest_at "
                "FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.conversation_id "
                "AND cm.session_id = ?1 AND cm.removed_at IS NULL AND cm.can_read = 1 "
                "LEFT JOIN window_cursors wc ON wc.window_id = ?2 AND wc.conversation_id = c.conversation_id "
                "WHERE c.status = 'open' AND c.digest IS NOT NULL AND c.digest_seq > COALESCE(wc.read_seq, 0) "
                "AND c.digest_seq > COALESCE(wc.digest_seen, 0) ORDER BY c.digest_at DESC LIMIT 2",
                session.session_id, window.window_id);
            std::string digests;
            std::vector<std::pair<std::string, std::int64_t>> shown_digests;
            while (due.step()) {
                const std::string kind = due.text(1);
                const std::string where = kind == "lobby"    ? std::string("the lobby")
                                          : kind == "direct" ? std::string("a direct conversation with you")
                                                             : std::format("\"{}\"", due.text(2));
                digests += std::format(
                    "[ACM] Digest of {} up to message {}, written by {} ({}). It stands for the earlier messages there, "
                    "which are not listed for you one by one; read_messages has them if you need one:\n{}\n\n",
                    where, due.integer(4), due.optional_text(5).value_or("a member"), due.optional_text(6).value_or(""),
                    clip(due.text(3), kDigestBytes));
                shown_digests.emplace_back(due.text(0), due.integer(4));
            }
            if (!digests.empty()) {
                const std::string rest = result.at("text").get<std::string>();
                result["text"] = rest.empty() ? digests.substr(0, digests.size() - 2) : digests + rest;
                result["digests"] = shown_digests.size();
                if (!peek) {
                    for (const auto& [conversation, seq] : shown_digests) {
                        database_.execute(
                            "INSERT INTO window_cursors (window_id, conversation_id, read_seq, digest_seen) VALUES (?, ?, 0, ?) "
                            "ON CONFLICT (window_id, conversation_id) DO UPDATE SET digest_seen = excluded.digest_seen",
                            window.window_id, conversation, seq);
                    }
                }
            }
        }
        // The operator's shared rules go in front of a conversation once: when it starts
        // or next takes a prompt after they changed. They are the operator's, and say so.
        if (!urgent_only) {
            const auto rules = text_setting(database_, "shared_rules");
            const auto version = text_setting(database_, "shared_rules_at").value_or("");
            Statement seen = database_.query("SELECT rules_seen FROM windows WHERE window_id = ?", window.window_id);
            seen.step();
            if (rules && !rules->empty() && seen.optional_text(0).value_or("") != version) {
                const std::string block = std::format(
                    "[ACM] Shared rules for every session on this machine. They were set at the operator console by the "
                    "person who runs these sessions (last changed {}), and are that person's standing instructions, not a "
                    "message from another AI session:\n\n{}",
                    version, *rules);
                const std::string rest = result.at("text").get<std::string>();
                result["text"] = rest.empty() ? block : block + "\n\n" + rest;
                result["rules"] = true;
                if (!peek) {
                    database_.execute("UPDATE windows SET rules_seen = ? WHERE window_id = ?", version, window.window_id);
                }
            }
        }
        result["messages"] = std::move(messages);
        if (peek) {
            return result;
        }
        // Everything up to here has been looked at; a cut list ends at its last entry.
        const std::int64_t upto = cut ? listed.back().rowid : last_rowid();
        if (urgent_only) {
            database_.execute("UPDATE windows SET urgent_rowid = MAX(urgent_rowid, ?) WHERE window_id = ?", upto,
                              window.window_id);
        } else {
            database_.execute(
                "UPDATE windows SET shown_rowid = MAX(shown_rowid, ?), urgent_rowid = MAX(urgent_rowid, ?) "
                "WHERE window_id = ?",
                upto, upto, window.window_id);
        }
        if (!listed.empty()) {
            database_.execute(
                "INSERT INTO deliveries (session_id, window_id, created_at, route, status, upto_rowid, messages, urgent, "
                "from_rowid) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?)",
                session.session_id, window.window_id, now, event, upto, static_cast<std::int64_t>(listed.size()),
                static_cast<std::int64_t>(urgent), floor);
            // The event says that messages were shown and how many, never their text.
            events_.append("delivery.shown", {.project_id = session.project_id, .actor_id = session.session_id},
                           session.session_id,
                           {{"session_id", session.session_id},
                            {"window", window.name},
                            {"route", event},
                            {"messages", listed.size()},
                            {"urgent", urgent}});
        }
        return result;
    });
}

json Delivery::turn_ended(const json& args) {
    const auto window_id = require_string(args, "window_id", 96);
    const auto now = to_rfc3339(clock_());
    // Only a window still marked as in a turn; one that reported anything since keeps it.
    const auto changed = database_.execute(
        "UPDATE windows SET event = 'stop', seen_at = ? WHERE window_id = ? AND event IN ('prompt', 'tool')", now, window_id);
    return {{"window_id", window_id}, {"idle", changed > 0}};
}

json Delivery::limits() {
    const auto stored = text_setting(database_, "client_limits");
    json parsed = stored ? json::parse(*stored, nullptr, false) : json::object();
    json current = json::object();
    if (!parsed.is_object()) {
        return current;
    }
    const auto now = to_rfc3339(clock_());
    for (const auto& [client, mark] : parsed.items()) {
        if (mark.is_object() && mark.value("until", std::string()) > now) {
            current[client] = mark;
        }
    }
    return current;
}

json Delivery::limit_of(std::string_view client) {
    const json current = limits();
    return current.contains(std::string(client)) ? current.at(std::string(client)) : json(nullptr);
}

json Delivery::set_limit(const json& args) {
    const auto client = require_string(args, "client", 32);
    const auto until = optional_string(args, "until", 40);
    const auto detail = optional_string(args, "detail", 400);
    return database_.transaction([&] {
        json current = limits();
        const bool had = current.contains(client);
        const std::string previous_until = had ? current.at(client).value("until", std::string()) : std::string();
        if (until && !until->empty()) {
            current[client] = {{"until", *until}, {"detail", detail.value_or("")}, {"noted_at", to_rfc3339(clock_())}};
        } else {
            current.erase(client);
        }
        store_text_setting(database_, "client_limits", current.dump());
        // Emit once on state transition or changed retry time, rather than on every poll.
        if (until && !until->empty() && (!had || previous_until != *until)) {
            events_.append("client.quota_exhausted", {}, client, {{"client", client}, {"until", *until}, {"detail", detail.value_or("")}});
        } else if ((!until || until->empty()) && had) {
            events_.append("client.quota_restored", {}, client, {{"client", client}});
        }
        return current;
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
    // Windows for which a command-line turn started from here is still running.
    const std::vector<std::string> occupied =
        args.is_object() && args.contains("busy") ? optional_string_list(args, "busy") : std::vector<std::string>();
    const auto listed_in = [&](const char* name) {
        return args.is_object() && args.contains(name) ? optional_string_list(args, name) : std::vector<std::string>();
    };
    // Clients for which nothing is started this moment (a stand-in of theirs is at work).
    const std::vector<std::string> held = listed_in("busy_clients");
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    const auto ago = [&](std::int64_t seconds) { return to_rfc3339(moment - std::chrono::seconds(seconds)); };

    struct Candidate {
        std::string window_id;
        std::string session_id;
        std::string client;
        std::string client_session;
        std::optional<std::string> cwd;
        std::string seen_at;
        std::int64_t mark;
        std::string name;
        // How many steps of handing this over went unanswered so far.
        std::int64_t attempt = 0;
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
            "SELECT w.window_id, w.session_id, w.client, w.client_session, w.cwd, w.seen_at, "
            "MAX(w.shown_rowid, w.urgent_rowid), w.name, w.imported FROM windows w "
            "JOIN agent_sessions s ON s.session_id = w.session_id "
            "WHERE s.status = 'active' AND s.linked = 1 AND s.urgent_dispatch = 1 "
            "AND w.addressable = 1 AND w.client <> '' AND w.client_session <> '-' AND w.seen_at > ? "
            // Idle: its client last reported the start of the conversation or the end of a
            // turn; or, for a window without hooks, it has not called a tool for a while; or
            // its last turn began long ago and nothing was heard since (a turn that was cut
            // off reports no end). The roster calls such a window idle too (Windows::state_of).
            "AND ((w.event IN ('start', 'stop') AND w.seen_at <= ?) OR (w.event = 'tool' AND w.seen_at <= ?) "
            " OR (w.event = 'prompt' AND w.seen_at <= ?)) "
            // A live watcher delivers by itself, inside the conversation.
            "AND (w.watch_seen_at IS NULL OR w.watch_seen_at < ?) "
            "ORDER BY w.window_id",
            ago(Windows::kLiveSeconds), ago(kSettleSeconds), ago(kToolIdleSeconds), ago(Windows::kTurnSeconds),
            ago(kWatchAliveSeconds));
        while (rows.step()) {
            candidates.push_back({rows.text(0), rows.text(1), rows.text(2), rows.text(3), rows.optional_text(4),
                                  rows.text(5), rows.integer(6), rows.text(7)});
        }
        json jobs = json::array();
        // A client that has used up its quota cannot run a turn: nothing is started for it
        // until the time its vendor named. The messages stay unread meanwhile.
        const json out_of_quota = limits();
        for (auto& candidate : candidates) {
            if (limited && std::ranges::find(clients, candidate.client) == clients.end()) {
                continue;
            }
            if (out_of_quota.contains(candidate.client)) {
                continue;
            }
            if (std::ranges::find(occupied, candidate.window_id) != occupied.end() ||
                std::ranges::find(held, candidate.client) != held.end()) {
                continue;
            }
            // A message that was handed to the window's application, which then did
            // nothing with it: the window has not been heard of since, for as long as
            // that step allowed. The delivery is taken back and the next step is tried
            // (the gateway knows which that is; see dispatch.mjs).
            Statement silent = database_.query(
                "SELECT delivery_id, from_rowid, attempt FROM deliveries WHERE window_id = ? AND route = 'command' "
                "AND status = 'ok' AND unconfirmed > 0 AND from_rowid IS NOT NULL "
                "AND (julianday(?) - julianday(created_at)) * 86400.0 >= unconfirmed "
                "AND created_at > ? AND created_at > ? ORDER BY delivery_id DESC LIMIT 1",
                candidate.window_id, now, ago(kConfirmWindowSeconds), candidate.seen_at);
            if (silent.step()) {
                const std::int64_t stale = silent.integer(0);
                const std::int64_t from = silent.integer(1);
                candidate.attempt = silent.integer(2) + 1;
                database_.execute(
                    "UPDATE deliveries SET status = 'skipped', unconfirmed = 0, "
                    "detail = COALESCE(detail || '; ', '') || 'no turn started, trying the next step' "
                    "WHERE delivery_id = ?",
                    stale);
                database_.execute("UPDATE windows SET urgent_rowid = MIN(urgent_rowid, ?) WHERE window_id = ?", from,
                                  candidate.window_id);
                Statement marks = database_.query(
                    "SELECT MAX(shown_rowid, urgent_rowid) FROM windows WHERE window_id = ?", candidate.window_id);
                marks.step();
                candidate.mark = marks.integer(0);
            }
            Statement history = database_.query(
                "SELECT "
                "(SELECT COUNT(*) FROM deliveries WHERE window_id = ?1 AND status = 'running'), "
                "(SELECT COUNT(*) FROM deliveries WHERE window_id = ?1 AND route = 'command' AND created_at > ?2), "
                // Failed starts since the window was last used, and whether the latest is recent.
                "(SELECT COUNT(*) FROM deliveries WHERE window_id = ?1 AND route = 'command' AND status = 'failed' "
                " AND created_at >= ?3), "
                "(SELECT COUNT(*) FROM deliveries WHERE window_id = ?1 AND route = 'command' AND status = 'failed' "
                " AND created_at > ?4), "
                "(SELECT COUNT(*) FROM deliveries WHERE window_id = ?1 AND route IN ('stop', 'watch', 'command', 'tool') "
                " AND status NOT IN ('failed', 'skipped') AND created_at > ?5)",
                candidate.window_id, ago(kMinIntervalSeconds), candidate.seen_at, ago(kRetrySeconds),
                ago(kWindowSeconds));
            history.step();
            // The next step of a handing over is not held up by the distance kept between two starts.
            if (history.integer(0) > 0 || (history.integer(1) > 0 && candidate.attempt == 0) ||
                history.integer(2) >= kMaxFailures || history.integer(3) > 0 ||
                history.integer(4) >= kMaxUrgentDeliveries) {
                continue;
            }
            // A window is started for what names it, never because a message went to everybody.
            std::vector<Pending> listed = interrupting(candidate.session_id, candidate.window_id, candidate.mark);
            if (listed.empty()) {
                continue;
            }
            const bool cut = static_cast<std::int64_t>(listed.size()) > kMaxListed;
            if (cut) {
                listed.resize(static_cast<std::size_t>(kMaxListed));
            }
            const std::int64_t upto = cut ? listed.back().rowid : last_rowid();
            database_.execute(
                "INSERT INTO deliveries (session_id, window_id, created_at, route, status, upto_rowid, messages, urgent, "
                "from_rowid, attempt) VALUES (?, ?, ?, 'command', 'running', ?, ?, ?, ?, ?)",
                candidate.session_id, candidate.window_id, now, upto, static_cast<std::int64_t>(listed.size()),
                static_cast<std::int64_t>(listed.size()), candidate.mark, candidate.attempt);
            jobs.push_back({{"delivery_id", database_.last_insert_rowid()},
                            {"session_id", candidate.session_id},
                            {"window_id", candidate.window_id},
                            {"window", candidate.name},
                            {"client", candidate.client},
                            {"client_session", candidate.client_session},
                            {"cwd", nullable(candidate.cwd)},
                            // How many steps of handing it over went unanswered so far.
                            {"attempt", candidate.attempt},
                            {"retry", candidate.attempt > 0},
                            {"text", compose(listed, cut ? 1 : 0, "command", candidate.name)}});
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
    const bool gone = !ok && (optional_bool(args, "gone", false) || (detail && says_gone(*detail)));
    // Not tried at all this time (something else has to finish first): it comes up again.
    const bool postponed = !ok && !gone && optional_bool(args, "postponed", false);
    // Handed to a stand-in (another conversation acting for this window), not to the
    // window's own conversation: that one has not seen the message yet.
    const bool stand_in = ok && optional_bool(args, "stand_in", false);
    // The command only handed the message to the application; whether a turn starts is still to be seen.
    const bool expects_turn = ok && optional_bool(args, "expects_turn", false);
    // The command had been reported as under way and failed afterwards.
    const bool late = !ok && optional_bool(args, "late", false);
    return database_.transaction([&] {
        Statement found = database_.query(
            "SELECT d.session_id, d.status, d.upto_rowid, d.messages, s.project_id, d.window_id, d.from_rowid FROM deliveries d "
            "JOIN agent_sessions s ON s.session_id = d.session_id WHERE d.delivery_id = ? AND d.route = 'command'",
            *delivery_id);
        if (!found.step()) {
            fail("NOT_FOUND", std::format("delivery {} does not exist", *delivery_id));
        }
        const auto session_id = found.text(0);
        const auto upto = found.integer(2);
        const auto messages = found.integer(3);
        const auto project_id = found.text(4);
        const auto window_id = found.optional_text(5);
        if (found.text(1) == "running") {
            // "skipped": the conversation is not there any more. That is not a broken route,
            // so it is neither shown as a failure nor announced; the message stays unread.
            database_.execute("UPDATE deliveries SET status = ?, detail = ? WHERE delivery_id = ?",
                              ok ? "ok" : gone || postponed ? "skipped" : "failed", detail, *delivery_id);
            if (expects_turn) {
                // How long a sign of life may take depends on the step.
                const auto patience = optional_integer(args, "confirm_seconds", 5, 600).value_or(kConfirmSeconds);
                database_.execute("UPDATE deliveries SET unconfirmed = ? WHERE delivery_id = ?", patience, *delivery_id);
            }
            if (stand_in) {
                // Such a delivery covers nothing for the window's own conversation: its next
                // prompt still lists the message. It is not woken for it a second time.
                database_.execute("UPDATE deliveries SET stand_in = 1 WHERE delivery_id = ?", *delivery_id);
            }
            if (ok) {
                // Delivered: the hooks need not show these again as urgent.
                // Not beyond the last message that exists: messages may have been deleted meanwhile.
                database_.execute(
                    "UPDATE windows SET urgent_rowid = MIN(MAX(urgent_rowid, ?), "
                    "(SELECT COALESCE(MAX(rowid), 0) FROM messages)) WHERE window_id = ?",
                    upto, window_id);
            } else if (gone) {
                // The vendor does not know this conversation (a helper thread, or one that
                // was deleted): there is nothing to hand a message to, now or later.
                database_.execute("UPDATE windows SET addressable = 0 WHERE window_id = ?", window_id);
            }
            events_.append("delivery.dispatched", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"ok", ok}, {"messages", messages}});
        } else if (late && found.text(1) == "ok") {
            // The turn did not happen after all: nothing was delivered. The messages are
            // urgent for the window again, and the usual pause and count of failures apply.
            database_.execute("UPDATE deliveries SET status = 'failed', unconfirmed = 0, detail = ? WHERE delivery_id = ?",
                              detail, *delivery_id);
            if (!found.is_null(6)) {
                database_.execute("UPDATE windows SET urgent_rowid = MIN(urgent_rowid, ?) WHERE window_id = ?",
                                  found.integer(6), window_id);
            }
            events_.append("delivery.dispatched", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"ok", false}, {"messages", messages}, {"late", true}});
        }
        return view(session_id);
    });
}

json Delivery::list() {
    std::vector<std::string> ids;
    Statement rows = database_.query("SELECT DISTINCT session_id FROM windows ORDER BY session_id");
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
    // The session as a whole is described by the window that was used last.
    Statement row = database_.query(
        "SELECT w.client, w.event, w.seen_at, w.cwd, "
        "(SELECT SUM(runs) FROM windows WHERE session_id = ?1), "
        "(SELECT MAX(watch_seen_at) FROM windows WHERE session_id = ?1), "
        "(SELECT COUNT(*) FROM windows WHERE session_id = ?1 AND client_session <> '-'), "
        "(SELECT COUNT(*) FROM windows WHERE session_id = ?1 AND hooked = 1) "
        "FROM windows w WHERE w.session_id = ?1 ORDER BY w.hooked DESC, w.seen_at DESC LIMIT 1",
        session_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("session {} has no window", session_id));
    }
    json view = {{"session_id", session_id},
                 {"client", row.text(0)},
                 {"event", row.text(1)},
                 {"seen_at", row.text(2)},
                 // Whether the client told us which of its conversations ran the hook; the id itself stays here.
                 {"knows_conversation", row.integer(6) > 0},
                 {"cwd", nullable(row.optional_text(3))},
                 {"runs", row.integer(4)},
                 // Whether any of its windows ran a hook at all; tool calls alone also make a window known.
                 {"hooked", row.integer(7) > 0},
                 {"watch_seen_at", nullable(row.optional_text(5))},
                 {"windows", windows_.of_session(session_id, nullptr)},
                 {"last_delivery", nullptr},
                 {"last_urgent", nullptr}};
    const auto latest = [&](const char* filter) -> json {
        Statement found = database_.query(
            std::format("SELECT d.created_at, d.route, d.status, d.messages, d.urgent, d.detail, w.name FROM deliveries d "
                        "LEFT JOIN windows w ON w.window_id = d.window_id "
                        // A start that was skipped (its conversation was gone) delivered nothing and broke nothing.
                        "WHERE d.session_id = ? AND d.status <> 'skipped' {} ORDER BY d.delivery_id DESC LIMIT 1",
                        filter),
            session_id);
        if (!found.step()) {
            return nullptr;
        }
        return {{"at", found.text(0)},
                {"route", found.text(1)},
                {"status", found.text(2)},
                {"messages", found.integer(3)},
                {"urgent", found.integer(4)},
                {"detail", nullable(found.optional_text(5))},
                {"window", nullable(found.optional_text(6))}};
    };
    view["last_delivery"] = latest("");
    view["last_urgent"] = latest("AND d.route IN ('stop', 'watch', 'command', 'tool')");
    return view;
}

}  // namespace acm
