// Task board: the shared list of work items of one conversation. Every member
// that can read the conversation sees the same board; members that can write
// may add tasks, claim them and report their state. The operator can do the
// same from the console. A task is addressed by its number inside the
// conversation (#1, #2, ...).
#pragma once

#include "common.hpp"
#include "conversation.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"

namespace acm {

class Board {
public:
    Board(Database& database, EventLog& events, Conversations& conversations, Clock clock)
        : database_(database), events_(events), conversations_(conversations), clock_(std::move(clock)) {}

    // Agent: {conversation_id, include_closed?}. Needs read access.
    json list_tasks(const Session& session, const json& args);

    // Agent: {conversation_id, title, detail?, assignee_session_id?}. Needs write
    // access. assignee_session_id may be "me". Creating a task whose title equals
    // an open task of the conversation returns that task instead of a duplicate.
    json create_task(const Session& session, const json& args);

    // Agent: {task_id, status?, note?, assignee_session_id?, title?, detail?, expected_version?}.
    // status is todo|doing|blocked|done|cancelled. assignee_session_id may be
    // "me" to claim or null to release. A stale expected_version fails
    // VERSION_CONFLICT with the current task, so two agents cannot silently
    // overwrite each other.
    json update_task(const Session& session, const json& args);

    // Operator equivalents; the author is recorded as the operator.
    json admin_create_task(std::string_view conversation_id, const json& args);
    json admin_update_task(std::string_view task_id, const json& args);

    // Every task of a conversation, open ones first, in board order.
    json tasks(std::string_view conversation_id, bool include_closed);

private:
    json create(const Session* actor, std::string_view conversation_id, std::string_view project_id,
                const json& args);
    json update(const Session* actor, const json& args);
    json task_row(std::string_view task_id);
    void require_member_session(std::string_view conversation_id, std::string_view session_id);

    Database& database_;
    EventLog& events_;
    Conversations& conversations_;
    Clock clock_;
};

}  // namespace acm
