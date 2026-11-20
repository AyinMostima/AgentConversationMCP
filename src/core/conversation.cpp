#include "conversation.hpp"

#include "crypto.hpp"
#include "settings.hpp"

#include <format>
#include <set>

namespace acm {

namespace {

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

struct MemberSpec {
    std::string session_id;
    std::string role;
    bool can_read;
    bool can_write;
};

// Codes starting with '@' name the conversations the service opens itself (the
// lobby and direct conversations), so nothing an operator or agent types can
// collide with them.
void require_free_task_code(const std::string& task_code) {
    if (task_code.starts_with('@')) {
        fail("INVALID_ARGUMENT", "task codes starting with @ are reserved for the lobby and direct conversations");
    }
}

}  // namespace

json Conversations::create_project(const json& args) {
    const auto project_id = optional_string(args, "project_id", 96).value_or(new_id("prj"));
    const auto name = require_string(args, "name", 128);
    const auto root_path = optional_string(args, "root_path", 1024);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        if (database_.query("SELECT 1 FROM projects WHERE project_id = ?", project_id).step()) {
            fail("ALREADY_EXISTS", std::format("project {} already exists", project_id));
        }
        database_.execute("INSERT INTO projects (project_id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
                          project_id, name, root_path, now);
        json project = {
            {"project_id", project_id}, {"name", name}, {"root_path", nullable(root_path)}, {"created_at", now}};
        events_.append("project.created", {.project_id = project_id}, project_id, project);
        return project;
    });
}

json Conversations::create_conversation(const json& args) {
    const auto project_id = require_string(args, "project_id", 96);
    const auto task_code = require_string(args, "task_code", 64);
    require_free_task_code(task_code);
    const auto title = require_string(args, "title", 200);
    const auto purpose = optional_string(args, "purpose", 2000);
    const auto conversation_id = new_id("cnv");
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        if (!database_.query("SELECT 1 FROM projects WHERE project_id = ?", project_id).step()) {
            fail("NOT_FOUND", std::format("project {} does not exist", project_id));
        }
        if (database_.query("SELECT 1 FROM conversations WHERE project_id = ? AND task_code = ?", project_id,
                            task_code)
                .step()) {
            fail("ALREADY_EXISTS", std::format("task {} already has a conversation in this project", task_code));
        }
        database_.execute(
            "INSERT INTO conversations (conversation_id, project_id, task_code, title, purpose, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            conversation_id, project_id, task_code, title, purpose, now);
        events_.append("conversation.created", {.project_id = project_id, .conversation_id = conversation_id},
                       conversation_id, {{"task_code", task_code}, {"title", title}});
        return conversation_row(conversation_id);
    });
}

json Conversations::set_members(std::string_view conversation_id, const json& args) {
    const auto expected_version = optional_integer(args, "expected_version", 1, INT64_MAX);
    if (!expected_version) {
        fail("INVALID_ARGUMENT", "expected_version is required");
    }
    if (!args.contains("members") || !args.at("members").is_array() || args.at("members").size() > 64) {
        fail("INVALID_ARGUMENT", "members must be an array of at most 64 entries");
    }
    std::vector<MemberSpec> requested;
    std::set<std::string> seen;
    for (const auto& entry : args.at("members")) {
        MemberSpec spec{require_string(entry, "session_id", 96),
                        optional_string(entry, "role", 64).value_or("participant"),
                        optional_bool(entry, "can_read", true), optional_bool(entry, "can_write", true)};
        if (!seen.insert(spec.session_id).second) {
            fail("INVALID_ARGUMENT", std::format("session {} is listed more than once", spec.session_id));
        }
        requested.push_back(std::move(spec));
    }
    const auto now = to_rfc3339(clock_());

    // A version conflict is reported after the read-only check, with the state the caller must reconcile against.
    json conflict;
    json updated = database_.transaction([&]() -> json {
        Statement row = database_.query(
            "SELECT project_id, config_version, kind FROM conversations WHERE conversation_id = ?", conversation_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
        }
        const auto project_id = row.text(0);
        const auto current_version = row.integer(1);
        const auto kind = row.text(2);
        if (current_version != *expected_version) {
            conflict = conversation_row(conversation_id);
            return nullptr;
        }
        for (const auto& spec : requested) {
            Statement session = database_.query(
                "SELECT project_id, status, linked FROM agent_sessions WHERE session_id = ?", spec.session_id);
            if (!session.step()) {
                fail("NOT_FOUND", std::format("session {} does not exist", spec.session_id));
            }
            if (session.text(0) != project_id) {
                fail("CROSS_PROJECT",
                     std::format("session {} is bound to another project and cannot join this conversation",
                                 spec.session_id),
                     {{"session_id", spec.session_id}});
            }
            const auto status = session.text(1);
            if (status == "revoked" || status == "expired") {
                fail("SESSION_UNAVAILABLE",
                     std::format("session {} is {} and cannot be added", spec.session_id, status),
                     {{"session_id", spec.session_id}, {"status", status}});
            }
            // The lobby and direct conversations exist for linked sessions only, so a
            // member list cannot bring back a session the operator switched out.
            if (kind != "topic" && session.integer(2) == 0) {
                fail("NOT_LINKED",
                     std::format("session {} was taken out of the default interconnection and cannot be in this "
                                 "conversation",
                                 spec.session_id),
                     {{"session_id", spec.session_id}});
            }
            // A direct conversation belongs to its two sessions. They can be removed
            // and restored, but nobody else can be let in to read their history.
            if (kind == "direct" &&
                !database_
                     .query("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND session_id = ?",
                            conversation_id, spec.session_id)
                     .step()) {
                fail("DIRECT_MEMBERS_FIXED",
                     std::format("session {} is not one of the two sessions of this direct conversation",
                                 spec.session_id),
                     {{"session_id", spec.session_id}});
            }
        }
        database_.execute(
            "UPDATE conversation_members SET removed_at = ?, removed_reason = 'operator' WHERE conversation_id = ? "
            "AND removed_at IS NULL",
            now, conversation_id);
        for (const auto& spec : requested) {
            database_.execute(
                "INSERT INTO conversation_members (conversation_id, session_id, role, can_read, can_write, added_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (conversation_id, session_id) DO UPDATE SET role = excluded.role, "
                "can_read = excluded.can_read, can_write = excluded.can_write, removed_at = NULL, "
                "removed_reason = NULL",
                conversation_id, spec.session_id, spec.role, spec.can_read, spec.can_write, now);
        }
        database_.execute("UPDATE conversations SET config_version = config_version + 1 WHERE conversation_id = ?",
                          conversation_id);
        json members = json::array();
        for (const auto& spec : requested) {
            members.push_back(
                {{"session_id", spec.session_id}, {"can_read", spec.can_read}, {"can_write", spec.can_write}});
        }
        events_.append("conversation.members_changed",
                       {.project_id = project_id, .conversation_id = std::string(conversation_id)}, conversation_id,
                       {{"config_version", current_version + 1}, {"members", members}});
        return conversation_row(conversation_id);
    });
    if (updated.is_null()) {
        fail("VERSION_CONFLICT",
             std::format("conversation {} changed since version {}; review the current members and retry",
                         conversation_id, *expected_version),
             {{"current", conflict}});
    }
    return updated;
}

json Conversations::get(std::string_view conversation_id) {
    return conversation_row(conversation_id);
}

json Conversations::update(std::string_view conversation_id, const json& args) {
    if (!args.is_object() || args.empty()) {
        fail("INVALID_ARGUMENT", "give title, task_code, purpose and/or archived to change");
    }
    const auto title = optional_string(args, "title", 200);
    const auto task_code = optional_string(args, "task_code", 64);
    const bool has_purpose = args.contains("purpose");
    if (has_purpose && !args.at("purpose").is_string() && !args.at("purpose").is_null()) {
        fail("INVALID_ARGUMENT", "purpose must be text or null");
    }
    const std::string purpose_text = has_purpose && args.at("purpose").is_string() ? args.at("purpose").get<std::string>() : "";
    if (purpose_text.size() > 2000) {
        fail("INVALID_ARGUMENT", "purpose is limited to 2000 bytes");
    }
    if (args.contains("archived") && !args.at("archived").is_boolean()) {
        fail("INVALID_ARGUMENT", "archived must be true or false");
    }
    if (title && title->empty()) {
        fail("INVALID_ARGUMENT", "title must not be empty");
    }
    if (task_code) {
        require_free_task_code(*task_code);
    }
    return database_.transaction([&] {
        Statement row = database_.query(
            "SELECT project_id, kind, status, title, task_code, purpose FROM conversations WHERE conversation_id = ?",
            conversation_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
        }
        const auto project_id = row.text(0);
        const auto kind = row.text(1);
        const bool was_archived = row.text(2) == "archived";
        const auto old_title = row.text(3);
        const auto old_code = row.text(4);
        const auto old_purpose = row.optional_text(5);
        if ((title || task_code) && kind != "topic") {
            fail("INVALID_ARGUMENT", "only a task conversation has a title and a task code of its own");
        }
        json changed = json::object();
        if (title && *title != old_title) {
            database_.execute("UPDATE conversations SET title = ? WHERE conversation_id = ?", *title, conversation_id);
            changed["title"] = *title;
        }
        if (task_code && *task_code != old_code) {
            if (database_.query("SELECT 1 FROM conversations WHERE project_id = ? AND task_code = ?", project_id,
                                *task_code)
                    .step()) {
                fail("ALREADY_EXISTS", std::format("task {} already has a conversation in this project", *task_code));
            }
            database_.execute("UPDATE conversations SET task_code = ? WHERE conversation_id = ?", *task_code,
                              conversation_id);
            changed["task_code"] = *task_code;
        }
        if (has_purpose) {
            const auto purpose = purpose_text.empty() ? std::optional<std::string>() : std::optional<std::string>(purpose_text);
            if (purpose != old_purpose) {
                database_.execute("UPDATE conversations SET purpose = ? WHERE conversation_id = ?", purpose,
                                  conversation_id);
                changed["purpose_changed"] = true;
            }
        }
        if (!changed.empty()) {
            events_.append("conversation.updated", {.project_id = project_id, .conversation_id = std::string(conversation_id)},
                           conversation_id, changed);
        }
        if (args.contains("archived") && args.at("archived").get<bool>() != was_archived) {
            const bool archived = args.at("archived").get<bool>();
            if (archived && kind == "lobby") {
                fail("INVALID_ARGUMENT", "the lobby cannot be archived: every session of the project needs it. Clear its messages instead");
            }
            database_.execute("UPDATE conversations SET status = ? WHERE conversation_id = ?",
                              archived ? "archived" : "open", conversation_id);
            events_.append(archived ? "conversation.archived" : "conversation.restored",
                           {.project_id = project_id, .conversation_id = std::string(conversation_id)}, conversation_id,
                           {{"conversation_id", conversation_id}});
        }
        return conversation_row(conversation_id);
    });
}

std::int64_t Conversations::delete_messages(std::string_view conversation_id, const std::optional<std::string>& before) {
    // The messages to go, by the same condition in every statement.
    const std::string chosen = "SELECT message_id FROM messages WHERE conversation_id = ?1 AND (?2 IS NULL OR created_at < ?2)";
    const auto run = [&](const std::string& sql) { return database_.execute(sql, conversation_id, before); };
    // Artifact references registered by one of these messages go with it, and with them every mention of them.
    run("DELETE FROM message_artifacts WHERE message_id IN (" + chosen + ") OR artifact_id IN "
        "(SELECT artifact_id FROM artifact_refs WHERE message_id IN (" + chosen + "))");
    run("DELETE FROM progress_events WHERE message_id IN (" + chosen + ")");
    run("DELETE FROM artifact_refs WHERE message_id IN (" + chosen + ")");
    run("DELETE FROM message_recipients WHERE message_id IN (" + chosen + ")");
    // What stays may point at what goes: a later reply, or a copy forwarded into another conversation.
    run("UPDATE messages SET reply_to_message_id = NULL WHERE reply_to_message_id IN (" + chosen + ")");
    run("UPDATE messages SET forwarded_from = NULL WHERE forwarded_from IN (" + chosen + ")");
    const std::int64_t deleted = run("DELETE FROM messages WHERE conversation_id = ?1 AND (?2 IS NULL OR created_at < ?2)");
    if (deleted > 0) {
        // Row positions of deleted messages can be given out again, so nothing may
        // remember a position beyond the last message that still exists.
        database_.execute(
            "UPDATE client_hooks SET shown_rowid = MIN(shown_rowid, (SELECT COALESCE(MAX(rowid), 0) FROM messages)), "
            "urgent_rowid = MIN(urgent_rowid, (SELECT COALESCE(MAX(rowid), 0) FROM messages))");
        database_.execute(
            "UPDATE wake_hooks SET seen_message_rowid = MIN(seen_message_rowid, (SELECT COALESCE(MAX(rowid), 0) FROM messages))");
        database_.execute(
            "UPDATE deliveries SET upto_rowid = MIN(upto_rowid, (SELECT COALESCE(MAX(rowid), 0) FROM messages))");
    }
    return deleted;
}

json Conversations::clear_messages(std::string_view conversation_id, const json& args) {
    const auto days = optional_integer(args, "older_than_days", 0, 0, 36500);
    const auto before = days > 0 ? std::optional<std::string>(to_rfc3339(clock_() - std::chrono::hours(24 * days)))
                                 : std::optional<std::string>();
    return database_.transaction([&] {
        Statement row = database_.query("SELECT project_id FROM conversations WHERE conversation_id = ?", conversation_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
        }
        const auto project_id = row.text(0);
        const std::int64_t deleted = delete_messages(conversation_id, before);
        if (deleted > 0) {
            // The event says how many went and by which rule, never what they said.
            events_.append("conversation.cleared", {.project_id = project_id, .conversation_id = std::string(conversation_id)},
                           conversation_id, {{"deleted_messages", deleted}, {"older_than_days", days}});
        }
        json view = conversation_row(conversation_id);
        view["deleted_messages"] = deleted;
        return view;
    });
}

json Conversations::remove(std::string_view conversation_id) {
    return database_.transaction([&] {
        Statement row = database_.query(
            "SELECT project_id, kind, task_code, title FROM conversations WHERE conversation_id = ?", conversation_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
        }
        const auto project_id = row.text(0);
        const auto task_code = row.text(2);
        const auto title = row.text(3);
        if (row.text(1) == "lobby") {
            fail("INVALID_ARGUMENT", "the lobby cannot be deleted: every session of the project needs it. Clear its messages instead");
        }
        const std::int64_t messages = delete_messages(conversation_id, std::nullopt);
        // Artifact references that no message of this conversation registered cannot exist, but the
        // foreign keys decide, so everything that names the conversation is taken out by name.
        database_.execute("DELETE FROM message_artifacts WHERE artifact_id IN (SELECT artifact_id FROM artifact_refs WHERE conversation_id = ?)", conversation_id);
        database_.execute("DELETE FROM progress_events WHERE conversation_id = ?", conversation_id);
        database_.execute("DELETE FROM artifact_refs WHERE conversation_id = ?", conversation_id);
        const std::int64_t tasks = database_.execute("DELETE FROM tasks WHERE conversation_id = ?", conversation_id);
        database_.execute("UPDATE conversation_proposals SET conversation_id = NULL WHERE conversation_id = ?", conversation_id);
        database_.execute("DELETE FROM conversation_members WHERE conversation_id = ?", conversation_id);
        database_.execute("DELETE FROM conversations WHERE conversation_id = ?", conversation_id);
        events_.append("conversation.deleted", {.project_id = project_id}, conversation_id,
                       {{"conversation_id", conversation_id},
                        {"task_code", task_code},
                        {"title", title},
                        {"deleted_messages", messages},
                        {"deleted_tasks", tasks}});
        return json{{"conversation_id", conversation_id}, {"deleted", true}, {"deleted_messages", messages}, {"deleted_tasks", tasks}};
    });
}

json Conversations::list_all() {
    std::vector<std::string> ids;
    Statement rows = database_.query("SELECT conversation_id FROM conversations ORDER BY created_at, conversation_id");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json conversations = json::array();
    for (const auto& id : ids) {
        conversations.push_back(conversation_row(id));
    }
    return conversations;
}

json Conversations::list_projects() {
    json projects = json::array();
    Statement rows = database_.query(
        "SELECT project_id, name, root_path, created_at FROM projects ORDER BY created_at, project_id");
    while (rows.step()) {
        projects.push_back({{"project_id", rows.text(0)},
                            {"name", rows.text(1)},
                            {"root_path", nullable(rows.optional_text(2))},
                            {"created_at", rows.text(3)}});
    }
    return projects;
}

json Conversations::list_for_session(const Session& session) {
    json conversations = json::array();
    Statement rows = database_.query(
        "SELECT c.conversation_id, c.task_code, c.title, c.status, c.next_seq - 1, m.role, m.can_read, m.can_write, "
        "c.kind "
        "FROM conversation_members m JOIN conversations c ON c.conversation_id = m.conversation_id "
        "WHERE m.session_id = ? AND m.removed_at IS NULL AND c.status = 'open' ORDER BY c.created_at, c.conversation_id",
        session.session_id);
    while (rows.step()) {
        conversations.push_back({{"conversation_id", rows.text(0)},
                                 {"task_code", rows.text(1)},
                                 {"title", rows.text(2)},
                                 {"status", rows.text(3)},
                                 {"last_seq", rows.integer(4)},
                                 {"role", rows.text(5)},
                                 {"can_read", rows.integer(6) != 0},
                                 {"can_write", rows.integer(7) != 0},
                                 {"kind", rows.text(8)}});
    }
    // A direct conversation has no title of its own; say who is on the other side.
    for (auto& entry : conversations) {
        if (entry.at("kind") != "direct") {
            continue;
        }
        json with = json::array();
        for (const auto& member : member_rows(entry.at("conversation_id").get<std::string>())) {
            if (member.at("session_id") != session.session_id) {
                with.push_back({{"session_id", member.at("session_id")},
                                {"label", member.at("label")},
                                {"display_name", member.at("display_name")}});
            }
        }
        entry["with"] = std::move(with);
    }
    return conversations;
}

json Conversations::get_for_session(const Session& session, std::string_view conversation_id) {
    const Access access = require_member(session, conversation_id);
    json view = conversation_row(conversation_id);
    view["your_access"] = {{"role", access.role}, {"can_read", access.can_read}, {"can_write", access.can_write}};
    return view;
}

Access Conversations::require_member(const Session& session, std::string_view conversation_id) {
    Statement row = database_.query(
        "SELECT c.project_id, m.role, m.can_read, m.can_write, c.status FROM conversation_members m "
        "JOIN conversations c ON c.conversation_id = m.conversation_id "
        "WHERE m.conversation_id = ? AND m.session_id = ? AND m.removed_at IS NULL",
        conversation_id, session.session_id);
    if (!row.step()) {
        fail("NOT_MEMBER",
             std::format("conversation {} does not exist or this session is not a member of it", conversation_id),
             {{"conversation_id", conversation_id}, {"session_id", session.session_id}});
    }
    if (row.text(4) == "archived") {
        fail("CONVERSATION_ARCHIVED",
             std::format("conversation {} was archived by the operator; it is closed until the operator restores it",
                         conversation_id),
             {{"conversation_id", conversation_id}});
    }
    return {std::string(conversation_id), row.text(0), row.text(1), row.integer(2) != 0, row.integer(3) != 0};
}

Access Conversations::require_reader(const Session& session, std::string_view conversation_id) {
    Access access = require_member(session, conversation_id);
    if (!access.can_read) {
        fail("READ_DENIED", std::format("this session may not read conversation {}", conversation_id),
             {{"conversation_id", conversation_id}});
    }
    return access;
}

Access Conversations::require_writer(const Session& session, std::string_view conversation_id) {
    Access access = require_member(session, conversation_id);
    if (!access.can_write) {
        fail("WRITE_DENIED", std::format("this session may not write to conversation {}", conversation_id),
             {{"conversation_id", conversation_id}});
    }
    return access;
}

std::vector<std::string> Conversations::readers(std::string_view conversation_id) {
    std::vector<std::string> sessions;
    Statement rows = database_.query(
        "SELECT session_id FROM conversation_members WHERE conversation_id = ? AND removed_at IS NULL "
        "AND can_read = 1 ORDER BY session_id",
        conversation_id);
    while (rows.step()) {
        sessions.push_back(rows.text(0));
    }
    return sessions;
}

json Conversations::conversation_row(std::string_view conversation_id) {
    Statement row = database_.query(
        "SELECT conversation_id, project_id, task_code, title, purpose, status, config_version, next_seq - 1, "
        "created_at, goal, goal_updated_at, kind FROM conversations WHERE conversation_id = ?",
        conversation_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
    }
    json view = {{"conversation_id", row.text(0)},
                 {"project_id", row.text(1)},
                 {"task_code", row.text(2)},
                 {"title", row.text(3)},
                 {"purpose", nullable(row.optional_text(4))},
                 {"status", row.text(5)},
                 {"config_version", row.integer(6)},
                 {"last_seq", row.integer(7)},
                 {"created_at", row.text(8)},
                 {"goal", nullable(row.optional_text(9))},
                 {"goal_updated_at", nullable(row.optional_text(10))},
                 {"kind", row.text(11)}};
    view["members"] = member_rows(conversation_id);
    // How much is in it and when it was last used, for deciding what to put away.
    Statement volume = database_.query(
        "SELECT COUNT(*), MAX(created_at), (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id = ?1 AND "
        "t.status IN ('todo', 'doing', 'blocked')) FROM messages WHERE conversation_id = ?1",
        conversation_id);
    volume.step();
    view["message_count"] = volume.integer(0);
    view["last_message_at"] = nullable(volume.optional_text(1));
    view["open_tasks"] = volume.integer(2);
    if (view.at("kind") == "direct") {
        // The two sessions of a direct conversation that are currently out of it,
        // and why, so the operator can see and restore them.
        json former = json::array();
        Statement gone = database_.query(
            "SELECT m.session_id, s.label, a.display_name, COALESCE(m.removed_reason, 'operator') "
            "FROM conversation_members m JOIN agent_sessions s ON s.session_id = m.session_id "
            "JOIN agents a ON a.agent_id = s.agent_id "
            "WHERE m.conversation_id = ? AND m.removed_at IS NOT NULL ORDER BY m.session_id",
            conversation_id);
        while (gone.step()) {
            former.push_back({{"session_id", gone.text(0)},
                              {"label", gone.text(1)},
                              {"display_name", gone.text(2)},
                              {"removed_reason", gone.text(3)}});
        }
        view["former_members"] = std::move(former);
    }
    return view;
}

json Conversations::set_goal(std::string_view conversation_id, const json& args) {
    const auto goal = optional_string(args, "goal", 4000);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement row = database_.query("SELECT project_id FROM conversations WHERE conversation_id = ?",
                                        conversation_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
        }
        const auto project_id = row.text(0);
        database_.execute("UPDATE conversations SET goal = ?, goal_updated_at = ? WHERE conversation_id = ?", goal,
                          now, conversation_id);
        // The goal text is conversation content, so the event only says that it changed.
        events_.append("conversation.goal_changed",
                       {.project_id = project_id, .conversation_id = std::string(conversation_id)}, conversation_id,
                       {{"has_goal", goal.has_value()}});
        return conversation_row(conversation_id);
    });
}

json Conversations::propose(const Session& session, const json& args) {
    const auto task_code = require_string(args, "task_code", 64);
    require_free_task_code(task_code);
    const auto title = require_string(args, "title", 200);
    const auto purpose = optional_string(args, "purpose", 2000);
    const auto goal = optional_string(args, "goal", 4000);
    std::set<std::string> members;
    for (const auto& member : optional_string_list(args, "member_session_ids")) {
        members.insert(member);
    }
    members.insert(session.session_id);
    const auto proposal_id = new_id("prp");
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        if (database_
                .query("SELECT 1 FROM conversations WHERE project_id = ? AND task_code = ?", session.project_id,
                       task_code)
                .step()) {
            fail("ALREADY_EXISTS", std::format("task {} already has a conversation in this project", task_code));
        }
        Statement pending = database_.query(
            "SELECT proposal_id FROM conversation_proposals WHERE project_id = ? AND task_code = ? AND "
            "status = 'pending'",
            session.project_id, task_code);
        if (pending.step()) {
            // Proposing the same task twice returns the proposal already waiting.
            json existing = proposal_row(pending.text(0));
            existing["already_pending"] = true;
            return existing;
        }
        for (const auto& member : members) {
            Statement row = database_.query("SELECT project_id, status FROM agent_sessions WHERE session_id = ?",
                                            member);
            if (!row.step() || row.text(0) != session.project_id || row.text(1) != "active") {
                fail("INVALID_MEMBER",
                     std::format("session {} is not an approved session of this project", member),
                     {{"session_id", member}});
            }
        }
        database_.execute(
            "INSERT INTO conversation_proposals (proposal_id, project_id, proposer_session_id, task_code, title, "
            "purpose, goal, member_session_ids, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
            proposal_id, session.project_id, session.session_id, task_code, title, purpose, goal,
            json(members).dump(), now);
        events_.append("proposal.created", {.project_id = session.project_id, .actor_id = session.session_id},
                       proposal_id, {{"proposal_id", proposal_id}, {"task_code", task_code}});
        return proposal_row(proposal_id);
    });
}

json Conversations::decide_proposal(std::string_view proposal_id, bool approve) {
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        const json proposal = proposal_row(proposal_id);
        if (proposal.at("status") != "pending") {
            return proposal;
        }
        const std::string project_id = proposal.at("project_id");
        std::optional<std::string> conversation_id;
        if (approve) {
            conversation_id = new_id("cnv");
            const std::string task_code = proposal.at("task_code");
            if (database_
                    .query("SELECT 1 FROM conversations WHERE project_id = ? AND task_code = ?", project_id, task_code)
                    .step()) {
                fail("ALREADY_EXISTS", std::format("task {} already has a conversation in this project", task_code));
            }
            database_.execute(
                "INSERT INTO conversations (conversation_id, project_id, task_code, title, purpose, goal, "
                "goal_updated_at, config_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?)",
                *conversation_id, project_id, task_code, proposal.at("title").get<std::string>(),
                proposal.at("purpose").is_null() ? std::optional<std::string>()
                                                 : proposal.at("purpose").get<std::string>(),
                proposal.at("goal").is_null() ? std::optional<std::string>() : proposal.at("goal").get<std::string>(),
                proposal.at("goal").is_null() ? std::optional<std::string>() : std::optional<std::string>(now), now);
            for (const auto& member : proposal.at("member_session_ids")) {
                // A member revoked while the proposal waited is simply left out.
                Statement usable = database_.query(
                    "SELECT 1 FROM agent_sessions WHERE session_id = ? AND status = 'active'",
                    member.get<std::string>());
                if (usable.step()) {
                    database_.execute(
                        "INSERT INTO conversation_members (conversation_id, session_id, role, can_read, can_write, "
                        "added_at) VALUES (?, ?, 'participant', 1, 1, ?)",
                        *conversation_id, member.get<std::string>(), now);
                }
            }
            events_.append("conversation.created", {.project_id = project_id, .conversation_id = conversation_id},
                           *conversation_id, {{"task_code", task_code}, {"proposal_id", proposal_id}});
        }
        database_.execute(
            "UPDATE conversation_proposals SET status = ?, conversation_id = ?, decided_at = ? WHERE proposal_id = ?",
            approve ? "approved" : "rejected", conversation_id, now, proposal_id);
        events_.append("proposal.decided", {.project_id = project_id}, proposal_id,
                       {{"proposal_id", proposal_id}, {"approved", approve}});
        return proposal_row(proposal_id);
    });
}

json Conversations::list_proposals() {
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT proposal_id FROM conversation_proposals ORDER BY status = 'pending' DESC, created_at DESC");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json proposals = json::array();
    for (const auto& id : ids) {
        proposals.push_back(proposal_row(id));
    }
    return proposals;
}

json Conversations::proposals_of(const Session& session) {
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT proposal_id FROM conversation_proposals WHERE proposer_session_id = ? ORDER BY created_at DESC "
        "LIMIT 20",
        session.session_id);
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json proposals = json::array();
    for (const auto& id : ids) {
        proposals.push_back(proposal_row(id));
    }
    return proposals;
}

json Conversations::roster(const Session& session) {
    json sessions = json::array();
    Statement rows = database_.query(
        "SELECT s.session_id, s.label, a.display_name, a.provider, s.linked FROM agent_sessions s "
        "JOIN agents a ON a.agent_id = s.agent_id WHERE s.project_id = ? AND s.status = 'active' "
        "ORDER BY a.display_name, s.label",
        session.project_id);
    while (rows.step()) {
        sessions.push_back({{"session_id", rows.text(0)},
                            {"label", rows.text(1)},
                            {"display_name", rows.text(2)},
                            {"provider", rows.text(3)},
                            {"linked", rows.integer(4) != 0},
                            {"is_you", rows.text(0) == session.session_id}});
    }
    return sessions;
}

void Conversations::add_member(std::string_view conversation_id, std::string_view session_id) {
    const auto now = to_rfc3339(clock_());
    database_.execute(
        "INSERT INTO conversation_members (conversation_id, session_id, role, can_read, can_write, added_at) "
        "VALUES (?, ?, 'participant', 1, 1, ?) "
        "ON CONFLICT (conversation_id, session_id) DO UPDATE SET removed_at = NULL, removed_reason = NULL",
        conversation_id, session_id, now);
    // Membership changed without the operator's editor, so its version moves on too.
    database_.execute("UPDATE conversations SET config_version = config_version + 1 WHERE conversation_id = ?",
                      conversation_id);
}

std::string Conversations::ensure_lobby(std::string_view project_id) {
    Statement existing = database_.query(
        "SELECT conversation_id FROM conversations WHERE project_id = ? AND kind = 'lobby'", project_id);
    if (existing.step()) {
        return existing.text(0);
    }
    const auto conversation_id = new_id("cnv");
    database_.execute(
        "INSERT INTO conversations (conversation_id, project_id, task_code, title, purpose, kind, created_at) "
        "VALUES (?, ?, '@lobby', 'Lobby', 'Shared by every linked session of this project.', 'lobby', ?)",
        conversation_id, project_id, to_rfc3339(clock_()));
    events_.append("conversation.created",
                   {.project_id = std::string(project_id), .conversation_id = conversation_id}, conversation_id,
                   {{"task_code", "@lobby"}, {"kind", "lobby"}});
    return conversation_id;
}

void Conversations::join_lobby(const Session& session) {
    if (!session.linked) {
        return;
    }
    // The common case, an existing membership row, costs one read and no write.
    Statement known = database_.query(
        "SELECT 1 FROM conversation_members m JOIN conversations c ON c.conversation_id = m.conversation_id "
        "WHERE c.project_id = ? AND c.kind = 'lobby' AND m.session_id = ?",
        session.project_id, session.session_id);
    if (known.step()) {
        return;
    }
    database_.transaction([&] {
        const auto lobby = ensure_lobby(session.project_id);
        add_member(lobby, session.session_id);
        events_.append("conversation.members_changed",
                       {.project_id = session.project_id, .conversation_id = lobby, .actor_id = session.session_id},
                       lobby, {{"joined", session.session_id}});
    });
}

json Conversations::direct(const Session& session, std::string_view peer_session_id) {
    if (peer_session_id == session.session_id) {
        fail("INVALID_ARGUMENT", "a session cannot open a direct conversation with itself");
    }
    if (!session.linked) {
        fail("NOT_LINKED", "this session was taken out of the default interconnection by the operator");
    }
    return database_.transaction([&] {
        Statement peer = database_.query(
            "SELECT project_id, status, linked FROM agent_sessions WHERE session_id = ?", peer_session_id);
        if (!peer.step() || peer.text(0) != session.project_id || peer.text(1) != "active") {
            fail("INVALID_RECIPIENT",
                 std::format("session {} is not an approved session of this project", peer_session_id),
                 {{"session_id", peer_session_id}});
        }
        if (peer.integer(2) == 0) {
            fail("NOT_LINKED", std::format("session {} does not take part in the default interconnection",
                                           peer_session_id),
                 {{"session_id", peer_session_id}});
        }
        // One conversation per pair, whoever opens it first.
        const std::string low = std::min(std::string(peer_session_id), session.session_id);
        const std::string high = std::max(std::string(peer_session_id), session.session_id);
        const std::string task_code = "@dm-" + sha256_hex(low + "|" + high).substr(0, 16);
        std::string conversation_id;
        Statement existing = database_.query(
            "SELECT conversation_id FROM conversations WHERE project_id = ? AND task_code = ?", session.project_id,
            task_code);
        const bool found = existing.step();
        if (found) {
            conversation_id = existing.text(0);
            // Put away by the operator, and now one of the two has something to say: it comes back.
            if (database_.execute("UPDATE conversations SET status = 'open' WHERE conversation_id = ? AND status = 'archived'",
                                  conversation_id) > 0) {
                events_.append("conversation.restored",
                               {.project_id = session.project_id,
                                .conversation_id = conversation_id,
                                .actor_id = session.session_id},
                               conversation_id, {{"conversation_id", conversation_id}, {"by", "direct_message"}});
            }
        }
        // Who of the pair still has to be let in. A membership the link switch
        // took away comes back with the link; one the operator ended stays ended,
        // so writing to the peer can never undo the operator's removal.
        std::vector<std::string> missing;
        for (const auto& member : {low, high}) {
            if (!found) {
                missing.push_back(member);
                continue;
            }
            Statement state = database_.query(
                "SELECT removed_at IS NULL, COALESCE(removed_reason, 'operator') FROM conversation_members "
                "WHERE conversation_id = ? AND session_id = ?",
                conversation_id, member);
            if (!state.step()) {
                missing.push_back(member);
            } else if (state.integer(0) == 0) {
                if (state.text(1) != "unlinked") {
                    fail("DIRECT_CLOSED",
                         "the operator removed a session from this direct conversation; it stays closed until the "
                         "operator restores that session",
                         {{"conversation_id", conversation_id}, {"session_id", member}});
                }
                missing.push_back(member);
            }
        }
        // A pair that already talks keeps its conversation. Opening one, or
        // rejoining one, is what the installation-wide switch governs.
        if (!missing.empty() && !open_mode(database_)) {
            fail("OPEN_MODE_OFF",
                 "default interconnection is off; ask the operator to add both sessions to a conversation");
        }
        if (!found) {
            conversation_id = new_id("cnv");
            database_.execute(
                "INSERT INTO conversations (conversation_id, project_id, task_code, title, kind, created_at) "
                "VALUES (?, ?, ?, 'Direct', 'direct', ?)",
                conversation_id, session.project_id, task_code, to_rfc3339(clock_()));
            events_.append("conversation.created",
                           {.project_id = session.project_id,
                            .conversation_id = conversation_id,
                            .actor_id = session.session_id},
                           conversation_id, {{"task_code", task_code}, {"kind", "direct"}});
        }
        for (const auto& member : missing) {
            add_member(conversation_id, member);
        }
        return conversation_row(conversation_id);
    });
}

void Conversations::apply_link(std::string_view session_id, bool linked) {
    const auto now = to_rfc3339(clock_());
    database_.transaction([&] {
        if (!linked) {
            // The version moves on first, so a member list loaded before the
            // switch is refused instead of putting the session back.
            database_.execute(
                "UPDATE conversations SET config_version = config_version + 1 WHERE kind IN ('lobby', 'direct') AND "
                "conversation_id IN (SELECT conversation_id FROM conversation_members WHERE session_id = ? AND "
                "removed_at IS NULL)",
                session_id);
            database_.execute(
                "UPDATE conversation_members SET removed_at = ?, removed_reason = 'unlinked' WHERE session_id = ? "
                "AND removed_at IS NULL AND conversation_id IN (SELECT conversation_id FROM conversations WHERE "
                "kind IN ('lobby', 'direct'))",
                now, session_id);
            return;
        }
        // Put the session back where unlinking took it out, and nowhere the
        // operator removed it by hand. A session that was never in the lobby
        // joins through join_lobby on its next call.
        Statement lobby = database_.query(
            "SELECT m.conversation_id FROM conversation_members m "
            "JOIN conversations c ON c.conversation_id = m.conversation_id "
            "JOIN agent_sessions s ON s.session_id = m.session_id "
            "WHERE m.session_id = ? AND m.removed_at IS NOT NULL AND m.removed_reason = 'unlinked' AND "
            "c.kind = 'lobby' AND s.status = 'active'",
            session_id);
        if (lobby.step()) {
            add_member(lobby.text(0), session_id);
        }
    });
}

json Conversations::proposal_row(std::string_view proposal_id) {
    Statement row = database_.query(
        "SELECT p.proposal_id, p.project_id, p.proposer_session_id, p.task_code, p.title, p.purpose, p.goal, "
        "p.member_session_ids, p.status, p.conversation_id, p.created_at, p.decided_at, s.label, a.display_name, "
        "a.provider FROM conversation_proposals p JOIN agent_sessions s ON s.session_id = p.proposer_session_id "
        "JOIN agents a ON a.agent_id = s.agent_id WHERE p.proposal_id = ?",
        proposal_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("proposal {} does not exist", proposal_id));
    }
    return {{"proposal_id", row.text(0)},
            {"project_id", row.text(1)},
            {"proposer_session_id", row.text(2)},
            {"task_code", row.text(3)},
            {"title", row.text(4)},
            {"purpose", nullable(row.optional_text(5))},
            {"goal", nullable(row.optional_text(6))},
            {"member_session_ids", json::parse(row.text(7))},
            {"status", row.text(8)},
            {"conversation_id", nullable(row.optional_text(9))},
            {"created_at", row.text(10)},
            {"decided_at", nullable(row.optional_text(11))},
            {"proposer", {{"label", row.text(12)}, {"display_name", row.text(13)}, {"provider", row.text(14)}}}};
}

json Conversations::member_rows(std::string_view conversation_id) {
    json members = json::array();
    Statement rows = database_.query(
        "SELECT m.session_id, m.role, m.can_read, m.can_write, s.agent_id, s.label, s.status, a.provider, "
        "a.display_name FROM conversation_members m JOIN agent_sessions s ON s.session_id = m.session_id "
        "JOIN agents a ON a.agent_id = s.agent_id "
        "WHERE m.conversation_id = ? AND m.removed_at IS NULL ORDER BY m.added_at, m.session_id",
        conversation_id);
    while (rows.step()) {
        members.push_back({{"session_id", rows.text(0)},
                           {"role", rows.text(1)},
                           {"can_read", rows.integer(2) != 0},
                           {"can_write", rows.integer(3) != 0},
                           {"agent_id", rows.text(4)},
                           {"label", rows.text(5)},
                           {"session_status", rows.text(6)},
                           {"provider", rows.text(7)},
                           {"display_name", rows.text(8)}});
    }
    return members;
}

}  // namespace acm
