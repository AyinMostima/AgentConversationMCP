#include "board.hpp"

#include <algorithm>
#include <format>

namespace acm {

namespace {

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

bool is_status(std::string_view status) {
    static constexpr std::string_view allowed[] = {"todo", "doing", "blocked", "done", "cancelled"};
    return std::ranges::find(allowed, status) != std::end(allowed);
}

// Distinguishes "leave the assignee alone" (absent) from "release it" (null).
struct AssigneeChange {
    bool present = false;
    std::optional<std::string> session_id;
};

AssigneeChange read_assignee(const json& args, const Session* actor) {
    AssigneeChange change;
    if (!args.is_object() || !args.contains("assignee_session_id")) {
        return change;
    }
    change.present = true;
    const json& value = args.at("assignee_session_id");
    if (value.is_null()) {
        return change;
    }
    if (!value.is_string() || value.get_ref<const std::string&>().empty()) {
        fail("INVALID_ARGUMENT", "assignee_session_id must be a session id, \"me\" or null");
    }
    change.session_id = value.get<std::string>();
    if (*change.session_id == "me") {
        if (actor == nullptr) {
            fail("INVALID_ARGUMENT", "the operator cannot assign a task to \"me\"; name a session");
        }
        change.session_id = actor->session_id;
    }
    return change;
}

}  // namespace

void Board::require_member_session(std::string_view conversation_id, std::string_view session_id) {
    if (!database_
             .query("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND session_id = ? AND "
                    "removed_at IS NULL",
                    conversation_id, session_id)
             .step()) {
        fail("INVALID_ASSIGNEE", std::format("session {} is not a member of this conversation", session_id),
             {{"session_id", session_id}});
    }
}

json Board::list_tasks(const Session& session, const json& args) {
    const auto conversation_id = require_string(args, "conversation_id", 96);
    conversations_.require_reader(session, conversation_id);
    return {{"conversation_id", conversation_id},
            {"tasks", tasks(conversation_id, optional_bool(args, "include_closed", false))}};
}

json Board::create_task(const Session& session, const json& args) {
    const auto conversation_id = require_string(args, "conversation_id", 96);
    const Access access = conversations_.require_writer(session, conversation_id);
    return create(&session, conversation_id, access.project_id, args);
}

json Board::admin_create_task(std::string_view conversation_id, const json& args) {
    Statement row = database_.query("SELECT project_id FROM conversations WHERE conversation_id = ?",
                                    conversation_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
    }
    return create(nullptr, conversation_id, row.text(0), args);
}

json Board::update_task(const Session& session, const json& args) {
    return update(&session, args);
}

json Board::admin_update_task(std::string_view task_id, const json& args) {
    json with_id = args.is_object() ? args : json::object();
    with_id["task_id"] = task_id;
    return update(nullptr, with_id);
}

json Board::create(const Session* actor, std::string_view conversation_id, std::string_view project_id,
                   const json& args) {
    const auto title = require_string(args, "title", 200);
    const auto detail = optional_string(args, "detail", 4000);
    const AssigneeChange assignee = read_assignee(args, actor);
    const auto actor_id = actor != nullptr ? std::optional<std::string>(actor->session_id) : std::nullopt;
    const auto task_id = new_id("tsk");
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement same = database_.query(
            "SELECT task_id FROM tasks WHERE conversation_id = ? AND title = ? AND status NOT IN ('done', "
            "'cancelled')",
            conversation_id, title);
        if (same.step()) {
            json existing = task_row(same.text(0));
            existing["already_exists"] = true;
            return existing;
        }
        if (assignee.session_id) {
            require_member_session(conversation_id, *assignee.session_id);
        }
        Statement next = database_.query("SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE conversation_id = ?",
                                         conversation_id);
        next.step();
        const std::int64_t number = next.integer(0);
        database_.execute(
            "INSERT INTO tasks (task_id, conversation_id, number, title, detail, status, assignee_session_id, "
            "created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            task_id, conversation_id, number, title, detail, assignee.session_id ? "doing" : "todo",
            assignee.session_id, actor_id, actor_id, now, now);
        events_.append("task.created",
                       {.project_id = std::string(project_id),
                        .conversation_id = std::string(conversation_id),
                        .actor_id = actor_id},
                       task_id, {{"task_id", task_id}, {"number", number}});
        json created = task_row(task_id);
        created["already_exists"] = false;
        return created;
    });
}

json Board::update(const Session* actor, const json& args) {
    const auto task_id = require_string(args, "task_id", 96);
    const auto status = optional_string(args, "status", 16);
    if (status && !is_status(*status)) {
        fail("INVALID_ARGUMENT", "status must be todo, doing, blocked, done or cancelled");
    }
    const auto note = optional_string(args, "note", 2000);
    const auto title = optional_string(args, "title", 200);
    const auto detail = optional_string(args, "detail", 4000);
    const auto expected_version = optional_integer(args, "expected_version", 1, INT64_MAX);
    const AssigneeChange assignee = read_assignee(args, actor);
    if (!status && !note && !title && !detail && !assignee.present) {
        fail("INVALID_ARGUMENT", "nothing to change: give status, note, assignee_session_id, title or detail");
    }
    const auto actor_id = actor != nullptr ? std::optional<std::string>(actor->session_id) : std::nullopt;
    const auto now = to_rfc3339(clock_());

    json conflict;
    json updated = database_.transaction([&]() -> json {
        Statement row = database_.query(
            "SELECT t.conversation_id, t.version, t.status, c.project_id, t.assignee_session_id FROM tasks t "
            "JOIN conversations c ON c.conversation_id = t.conversation_id WHERE t.task_id = ?",
            task_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("task {} does not exist", task_id));
        }
        const auto conversation_id = row.text(0);
        const auto version = row.integer(1);
        const auto project_id = row.text(3);
        if (actor != nullptr) {
            conversations_.require_writer(*actor, conversation_id);
        }
        if (expected_version && *expected_version != version) {
            conflict = task_row(task_id);
            return nullptr;
        }
        // A task somebody holds is theirs until they release it or the operator
        // reassigns it, so two sessions can never both be told a claim succeeded.
        if (actor != nullptr && assignee.present) {
            const auto holder = row.optional_text(4);
            if (holder && *holder != actor->session_id) {
                fail("ALREADY_CLAIMED",
                     std::format("task {} is held by another session; it has to release the task, or the operator "
                                 "reassigns it",
                                 task_id),
                     {{"current", task_row(task_id)}});
            }
        }
        if (assignee.session_id) {
            require_member_session(conversation_id, *assignee.session_id);
        }
        // Claiming a task that is still "todo" starts it, unless the caller set a status.
        std::optional<std::string> next_status = status;
        if (!next_status && assignee.session_id && row.text(2) == "todo") {
            next_status = "doing";
        }
        database_.execute(
            "UPDATE tasks SET status = COALESCE(?, status), note = COALESCE(?, note), title = COALESCE(?, title), "
            "detail = COALESCE(?, detail), updated_by = ?, updated_at = ?, version = version + 1 WHERE task_id = ?",
            next_status, note, title, detail, actor_id, now, task_id);
        if (assignee.present) {
            database_.execute("UPDATE tasks SET assignee_session_id = ? WHERE task_id = ?", assignee.session_id,
                              task_id);
        }
        events_.append("task.updated",
                       {.project_id = project_id, .conversation_id = conversation_id, .actor_id = actor_id}, task_id,
                       {{"task_id", task_id}, {"status", nullable(next_status)}});
        return task_row(task_id);
    });
    if (updated.is_null()) {
        fail("VERSION_CONFLICT", std::format("task {} changed since you read it; review it and retry", task_id),
             {{"current", conflict}});
    }
    return updated;
}

json Board::tasks(std::string_view conversation_id, bool include_closed) {
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT task_id FROM tasks WHERE conversation_id = ? AND (? = 1 OR status NOT IN ('done', 'cancelled')) "
        "ORDER BY status IN ('done', 'cancelled'), number",
        conversation_id, include_closed);
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json list = json::array();
    for (const auto& id : ids) {
        list.push_back(task_row(id));
    }
    return list;
}

std::int64_t Board::close(const Session* actor, std::string_view conversation_id, const json& handles,
                          const std::string& note) {
    if (!handles.is_array() || handles.size() > 100) {
        fail("INVALID_ARGUMENT", "close_tasks must be a list of at most 100 task numbers or task ids");
    }
    std::int64_t closed = 0;
    for (const auto& handle : handles) {
        Statement row = handle.is_number_integer()
                            ? database_.query("SELECT task_id, status FROM tasks WHERE conversation_id = ? AND number = ?",
                                              conversation_id, handle.get<std::int64_t>())
                            : handle.is_string()
                                  ? database_.query("SELECT task_id, status FROM tasks WHERE conversation_id = ? AND task_id = ?",
                                                    conversation_id, handle.get<std::string>())
                                  : database_.query("SELECT task_id, status FROM tasks WHERE 0");
        if (!row.step()) {
            fail("NOT_FOUND", std::format("this conversation has no task {}", handle.dump()), {{"task", handle}});
        }
        const std::string task_id = row.text(0);
        const std::string status = row.text(1);
        if (status == "done" || status == "cancelled") {
            continue;
        }
        update(actor, {{"task_id", task_id}, {"status", "done"}, {"note", note}});
        ++closed;
    }
    return closed;
}

json Board::task_row(std::string_view task_id) {
    Statement row = database_.query(
        "SELECT t.task_id, t.conversation_id, t.number, t.title, t.detail, t.status, t.assignee_session_id, "
        "t.created_by, t.updated_by, t.note, t.version, t.created_at, t.updated_at, s.label, a.display_name "
        "FROM tasks t LEFT JOIN agent_sessions s ON s.session_id = t.assignee_session_id "
        "LEFT JOIN agents a ON a.agent_id = s.agent_id WHERE t.task_id = ?",
        task_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("task {} does not exist", task_id));
    }
    json assignee = nullptr;
    if (!row.is_null(6)) {
        assignee = {{"session_id", row.text(6)}, {"label", row.text(13)}, {"display_name", row.text(14)}};
    }
    return {{"task_id", row.text(0)},
            {"conversation_id", row.text(1)},
            {"number", row.integer(2)},
            {"title", row.text(3)},
            {"detail", nullable(row.optional_text(4))},
            {"status", row.text(5)},
            {"assignee", assignee},
            {"created_by", nullable(row.optional_text(7))},
            {"updated_by", nullable(row.optional_text(8))},
            {"note", nullable(row.optional_text(9))},
            {"version", row.integer(10)},
            {"created_at", row.text(11)},
            {"updated_at", row.text(12)}};
}

}  // namespace acm
