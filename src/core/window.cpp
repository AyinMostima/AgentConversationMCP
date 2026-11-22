#include "window.hpp"

#include "crypto.hpp"

#include <algorithm>
#include <format>

namespace acm {

namespace {

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

// A name is a handle typed by models and people: short, one word, no characters
// that end it in a list or a sentence.
void require_name(const std::string& name) {
    const bool bad = name.empty() || name.size() > 48 ||
                     std::ranges::any_of(name, [](unsigned char c) {
                         return c <= 0x20 || c == ',' || c == '"' || c == '\'' || c == '[' || c == ']' || c == 0x7F;
                     }) ||
                     name.starts_with("win_");
    if (bad) {
        fail("INVALID_ARGUMENT",
             "name must be 1 to 48 bytes without blanks, commas, quotes or brackets, and must not start with win_");
    }
}

}  // namespace

std::optional<Window> Windows::resolve(const Session& session, const std::optional<std::string>& client,
                                       const std::optional<std::string>& client_session,
                                       const std::optional<std::string>& cwd) {
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    if (!client_session || client_session->empty()) {
        // The client did not say which conversation this is. During a turn of exactly
        // one of its windows there is no doubt; otherwise nothing is assumed.
        Statement rows = database_.query(
            "SELECT window_id, name FROM windows WHERE session_id = ? AND event = 'prompt' AND seen_at > ? LIMIT 2",
            session.session_id, to_rfc3339(moment - std::chrono::seconds(kTurnSeconds)));
        std::vector<Window> in_turn;
        while (rows.step()) {
            in_turn.push_back({rows.text(0), session.session_id, rows.text(1)});
        }
        return in_turn.size() == 1 ? std::optional<Window>(in_turn.front()) : std::nullopt;
    }
    Statement known = database_.query(
        "SELECT window_id, name FROM windows WHERE session_id = ? AND client_session = ?", session.session_id,
        *client_session);
    if (known.step()) {
        // Heard of by itself now: no longer only a record that was taken over.
        database_.execute("UPDATE windows SET imported = 0 WHERE window_id = ? AND imported = 1", known.text(0));
        return Window{known.text(0), session.session_id, known.text(1)};
    }
    const std::string window_id = new_id("win");
    // A generated name that tells the application; the window may choose a better one.
    const std::string base = client && !client->empty() ? *client : std::string("window");
    std::string name;
    for (int attempt = 0; attempt < 8; ++attempt) {
        name = std::format("{}-{}", base, random_hex(2));
        if (!database_.query("SELECT 1 FROM windows WHERE name = ?", name).step()) {
            break;
        }
    }
    database_.execute(
        "INSERT INTO windows (window_id, session_id, client, client_session, name, cwd, event, seen_at, created_at, "
        "shown_rowid, urgent_rowid) VALUES (?, ?, ?, ?, ?, ?, 'tool', ?, ?, "
        // Where its hooks start: recent messages are still news to it, older ones are
        // history; and no urgent message from before it existed is delivered as urgent.
        "(SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE created_at <= ?), "
        "(SELECT COALESCE(MAX(rowid), 0) FROM messages))",
        window_id, session.session_id, client.value_or(""), *client_session, name, cwd, now, now,
        to_rfc3339(moment - std::chrono::seconds(kFreshSeconds)));
    // It starts where its session as a whole is at this moment, and reads for itself from here on.
    database_.execute(
        "INSERT INTO window_cursors (window_id, conversation_id, read_seq) "
        "SELECT ?, conversation_id, read_seq FROM conversation_members WHERE session_id = ? AND removed_at IS NULL",
        window_id, session.session_id);
    events_.append("window.opened", {.project_id = session.project_id, .actor_id = session.session_id}, window_id,
                   {{"window_id", window_id}, {"session_id", session.session_id}, {"name", name}});
    return Window{window_id, session.session_id, name};
}

void Windows::set_name(std::string_view window_id, const std::string& name) {
    require_name(name);
    Statement row = database_.query(
        "SELECT w.name, w.session_id, s.project_id FROM windows w JOIN agent_sessions s ON s.session_id = w.session_id "
        "WHERE w.window_id = ?",
        window_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("window {} does not exist", window_id));
    }
    const auto old_name = row.text(0);
    const auto session_id = row.text(1);
    const auto project_id = row.text(2);
    if (old_name == name) {
        return;
    }
    // Names are compared without regard to ASCII case, the way people type them.
    Statement taken = database_.query(
        "SELECT w.window_id FROM windows w JOIN agent_sessions s ON s.session_id = w.session_id "
        "WHERE s.project_id = ? AND lower(w.name) = lower(?) AND w.window_id <> ? AND w.seen_at > ?",
        project_id, name, window_id, to_rfc3339(clock_() - std::chrono::seconds(kLiveSeconds)));
    if (taken.step()) {
        fail("NAME_TAKEN", std::format("another window of this project is called {}; choose a different name", name),
             {{"name", name}});
    }
    database_.execute("UPDATE windows SET name = ? WHERE window_id = ?", name, window_id);
    events_.append("window.renamed", {.project_id = project_id, .actor_id = session_id}, window_id,
                   {{"window_id", window_id}, {"name", name}, {"previous_name", old_name}});
}

json Windows::import(const json& args) {
    const auto client = require_string(args, "client", 32);
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    const auto live_since = to_rfc3339(moment - std::chrono::seconds(kLiveSeconds));
    return database_.transaction([&] {
        // The session that client registered for itself; the most recently used one.
        Statement owner = database_.query(
            "SELECT session_id, project_id FROM agent_sessions WHERE agent_id = ? AND status = 'active' "
            "AND self_enrolled = 1 ORDER BY last_seen_at DESC LIMIT 1",
            "agt_" + client);
        if (!owner.step()) {
            return json{{"session_id", nullptr}, {"added", 0}, {"known", 0}, {"retired", 0}};
        }
        const std::string session_id = owner.text(0);
        const std::string project_id = owner.text(1);
        std::int64_t added = 0;
        std::int64_t known = 0;
        if (!args.contains("windows") || !args.at("windows").is_array()) {
            fail("INVALID_ARGUMENT", "windows must be a list");
        }
        for (const auto& entry : args.at("windows")) {
            const auto client_session = require_string(entry, "client_session", 256);
            const auto seen_at = require_string(entry, "seen_at", 40);
            const auto cwd = optional_string(entry, "cwd", 1024);
            const auto title = optional_string(entry, "title", 300);
            const auto wanted = optional_string(entry, "name", 200).or_else([&] { return title; });
            // Nothing that is not live is taken over, and nothing from the future.
            if (seen_at <= live_since || seen_at > now) {
                continue;
            }
            Statement row = database_.query(
                "SELECT window_id, imported FROM windows WHERE session_id = ? AND client_session = ?", session_id,
                client_session);
            if (row.step()) {
                ++known;
                if (title && !title->empty()) {
                    // What its client calls it tells others what the window is for, whatever its name.
                    database_.execute("UPDATE windows SET title = ? WHERE window_id = ?", *title, row.text(0));
                }
                if (row.integer(1) != 0) {
                    // Still only known from the record: that record says when it was last active.
                    database_.execute(
                        "UPDATE windows SET seen_at = MAX(seen_at, ?), cwd = COALESCE(?, cwd) WHERE window_id = ?",
                        seen_at, cwd, row.text(0));
                }
                continue;
            }
            // The client's own title of the conversation as its name, as far as a name allows;
            // made distinct when another window of the project has it.
            std::string name;
            if (wanted) {
                for (unsigned char c : *wanted) {
                    const bool separator = c <= 0x20 || c == ',' || c == '"' || c == '\'' || c == '[' || c == ']' || c == 0x7F;
                    if (!separator) {
                        name.push_back(static_cast<char>(c));
                    } else if (!name.empty() && name.back() != '-') {
                        name.push_back('-');
                    }
                }
                // Cut on a character boundary: titles are often not ASCII.
                std::size_t end = std::min<std::size_t>(name.size(), 40);
                while (end > 0 && end < name.size() && (static_cast<unsigned char>(name[end]) & 0xC0) == 0x80) {
                    --end;
                }
                name.resize(end);
                while (!name.empty() && name.back() == '-') {
                    name.pop_back();
                }
                if (name.starts_with("win_")) {
                    name.clear();
                }
            }
            const auto taken = [&](const std::string& candidate) {
                return database_
                    .query("SELECT 1 FROM windows w JOIN agent_sessions s ON s.session_id = w.session_id "
                           "WHERE s.project_id = ? AND lower(w.name) = lower(?)",
                           project_id, candidate)
                    .step();
            };
            if (name.empty() || taken(name)) {
                const std::string base = name.empty() ? client : name;
                for (int attempt = 0; attempt < 8; ++attempt) {
                    name = std::format("{}-{}", base, random_hex(2));
                    if (!taken(name)) {
                        break;
                    }
                }
            }
            const std::string window_id = new_id("win");
            database_.execute(
                "INSERT INTO windows (window_id, session_id, client, client_session, name, cwd, event, seen_at, "
                "created_at, title, shown_rowid, urgent_rowid, imported) VALUES (?, ?, ?, ?, ?, ?, 'stop', ?, ?, ?, "
                // As for every new window: recent messages are news to it, and nothing that
                // was urgent before it was known interrupts it.
                "(SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE created_at <= ?), "
                "(SELECT COALESCE(MAX(rowid), 0) FROM messages), 1)",
                window_id, session_id, client, client_session, name, cwd, seen_at, now, title,
                to_rfc3339(moment - std::chrono::seconds(kFreshSeconds)));
            database_.execute(
                "INSERT INTO window_cursors (window_id, conversation_id, read_seq) "
                "SELECT ?, conversation_id, read_seq FROM conversation_members WHERE session_id = ? AND removed_at IS NULL",
                window_id, session_id);
            events_.append("window.opened", {.project_id = project_id, .actor_id = session_id}, window_id,
                           {{"window_id", window_id}, {"session_id", session_id}, {"name", name}, {"imported", true}});
            ++added;
        }
        // A sub-agent that called a tool looked like a conversation of its own. It is not
        // one anybody addresses, and starting it from outside would start nothing useful.
        std::int64_t retired = 0;
        if (args.contains("not_windows") && args.at("not_windows").is_array()) {
            for (const auto& entry : args.at("not_windows")) {
                if (!entry.is_string()) {
                    continue;
                }
                const std::string id = entry.get<std::string>();
                Statement listed = database_.query(
                    "SELECT window_id FROM windows WHERE session_id = ? AND client_session = ? AND addressable = 1",
                    session_id, id);
                if (listed.step()) {
                    database_.execute("UPDATE windows SET addressable = 0 WHERE window_id = ?", listed.text(0));
                    ++retired;
                }
            }
        }
        return json{{"session_id", session_id}, {"added", added}, {"known", known}, {"retired", retired}};
    });
}

json Windows::rename(const Session& session, const Window& window, const json& args) {
    const auto name = require_string(args, "name", 48);
    if (window.session_id != session.session_id) {
        fail("NOT_FOUND", std::format("window {} does not exist", window.window_id));
    }
    return database_.transaction([&] {
        set_name(window.window_id, name);
        return view(window.window_id);
    });
}

json Windows::admin_rename(std::string_view window_id, const json& args) {
    const auto name = require_string(args, "name", 48);
    return database_.transaction([&] {
        set_name(window_id, name);
        return view(window_id);
    });
}

std::vector<Window> Windows::lookup(std::string_view project_id, const std::vector<std::string>& handles) {
    std::vector<Window> found;
    const auto live_since = to_rfc3339(clock_() - std::chrono::seconds(kLiveSeconds));
    for (const auto& handle : handles) {
        Statement row = database_.query(
            "SELECT w.window_id, w.session_id, w.name FROM windows w JOIN agent_sessions s ON s.session_id = "
            "w.session_id WHERE s.project_id = ? AND s.status = 'active' AND w.seen_at > ? AND w.addressable = 1 "
            "AND (w.window_id = ? OR lower(w.name) = lower(?)) ORDER BY w.seen_at DESC LIMIT 1",
            project_id, live_since, handle, handle);
        if (!row.step()) {
            json names = json::array();
            // With what each is, so that the caller can pick the right one without asking anybody.
            json choices = json::array();
            Statement all = database_.query(
                "SELECT w.name, w.title, w.client, w.cwd FROM windows w JOIN agent_sessions s ON s.session_id = "
                "w.session_id WHERE s.project_id = ? AND s.status = 'active' AND w.seen_at > ? AND w.addressable = 1 "
                "ORDER BY w.name",
                project_id, live_since);
            while (all.step()) {
                names.push_back(all.text(0));
                choices.push_back({{"name", all.text(0)},
                                   {"title", nullable(all.optional_text(1))},
                                   {"client", all.text(2)},
                                   {"cwd", nullable(all.optional_text(3))}});
            }
            fail("UNKNOWN_WINDOW",
                 std::format("no window called {} is in use in this project; the windows that are: {}", handle,
                             names.empty() ? std::string("(none)") : names.dump()),
                 {{"window", handle}, {"windows", names}, {"choices", choices}});
        }
        const Window window{row.text(0), row.text(1), row.text(2)};
        if (std::ranges::none_of(found, [&](const Window& entry) { return entry.window_id == window.window_id; })) {
            found.push_back(window);
        }
    }
    return found;
}

std::string Windows::state_of(std::string_view event, std::string_view seen_at,
                              const std::optional<std::string>& watch_seen_at) {
    const auto moment = clock_();
    // In a turn: its client reported a prompt, or it called a tool, a short while ago.
    const bool recent = seen_at > to_rfc3339(moment - std::chrono::seconds(event == "tool" ? 120 : kTurnSeconds));
    if ((event == "prompt" || event == "tool") && recent) {
        return "busy";
    }
    if (watch_seen_at && *watch_seen_at > to_rfc3339(moment - std::chrono::seconds(90))) {
        return "watching";
    }
    return "idle";
}

std::int64_t Windows::count_of_session(std::string_view session_id) {
    Statement row = database_.query("SELECT COUNT(*) FROM windows WHERE session_id = ? AND seen_at > ? AND addressable = 1",
                                    session_id, to_rfc3339(clock_() - std::chrono::seconds(kLiveSeconds)));
    row.step();
    return row.integer(0);
}

json Windows::of_session(std::string_view session_id, const Window* self, std::int64_t limit) {
    json windows = json::array();
    Statement rows = database_.query(
        "SELECT window_id, name, event, seen_at, watch_seen_at, cwd, imported, title FROM windows WHERE session_id = ?1 "
        "AND seen_at > ?2 AND addressable = 1 ORDER BY (window_id = ?3) DESC, seen_at DESC LIMIT ?4",
        session_id, to_rfc3339(clock_() - std::chrono::seconds(kLiveSeconds)),
        self != nullptr ? self->window_id : std::string(), limit);
    while (rows.step()) {
        windows.push_back({{"window_id", rows.text(0)},
                           {"name", rows.text(1)},
                           // What its client shows as the title of the conversation, when known.
                           {"title", nullable(rows.optional_text(7))},
                           {"state", state_of(rows.text(2), rows.text(3), rows.optional_text(4))},
                           {"last_active_at", rows.text(3)},
                           {"cwd", nullable(rows.optional_text(5))},
                           {"is_you", self != nullptr && self->window_id == rows.text(0)},
                           // Known from its client's record only: it is woken when named, not by a message to everybody.
                           {"imported", rows.integer(6) != 0}});
    }
    return windows;
}

json Windows::view(std::string_view window_id) {
    Statement row = database_.query(
        "SELECT window_id, session_id, client, name, event, seen_at, watch_seen_at, cwd, runs, hooked, addressable, "
        "created_at FROM windows WHERE window_id = ?",
        window_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("window {} does not exist", window_id));
    }
    return {{"window_id", row.text(0)},
            {"session_id", row.text(1)},
            {"client", row.text(2)},
            {"name", row.text(3)},
            {"state", state_of(row.text(4), row.text(5), row.optional_text(6))},
            {"event", row.text(4)},
            {"last_active_at", row.text(5)},
            {"watch_seen_at", nullable(row.optional_text(6))},
            {"cwd", nullable(row.optional_text(7))},
            {"runs", row.integer(8)},
            // Whether its client ran a hook for it, and whether its client can still be handed a message for it.
            {"hooked", row.integer(9) != 0},
            {"addressable", row.integer(10) != 0},
            {"created_at", row.text(11)}};
}

}  // namespace acm
