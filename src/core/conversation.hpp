// Conversations and permissions: projects, task conversations, and which
// session instances may read or write each conversation.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"

namespace acm {

// What one session may do in one conversation.
struct Access {
    std::string conversation_id;
    std::string project_id;
    std::string role;
    bool can_read = false;
    bool can_write = false;
};

class Conversations {
public:
    Conversations(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // Operator: {project_id?, name, root_path?}.
    json create_project(const json& args);

    // Operator: {project_id, task_code, title, purpose?}. task_code is unique per project.
    json create_conversation(const json& args);

    // Operator: replace the member list.
    //   {expected_version, members: [{session_id, role?, can_read?, can_write?}]}
    // A stale expected_version fails VERSION_CONFLICT and carries the current state.
    // Sessions bound to another project fail CROSS_PROJECT. Dropped members keep
    // their row with removed_at so history stays attributable.
    json set_members(std::string_view conversation_id, const json& args);

    // Operator: keeping the list of conversations tidy.
    //
    // update {title?, task_code?, purpose?, archived?}: title and task code belong
    // to task conversations only (the lobby and direct conversations are named by
    // the service). An archived conversation is put away: sessions no longer see
    // it and nobody can write to it until it is restored; nothing is deleted. The
    // lobby cannot be archived. A direct conversation comes back by itself when
    // one of the two writes to the other again.
    json update(std::string_view conversation_id, const json& args);

    // clear_messages {older_than_days?}: deletes the messages of a conversation
    // for good, all of them or those older than that many days, together with
    // their receipts, progress reports and artifact references. Sequence numbers
    // are not reused. Returns {deleted_messages}.
    json clear_messages(std::string_view conversation_id, const json& args);

    // remove: deletes a conversation for good with everything in it. Not the
    // lobby, which every session of the project needs; clear it instead.
    json remove(std::string_view conversation_id);

    // Operator views.
    json get(std::string_view conversation_id);

    // A digest needs this many messages since the one before it; and it is due
    // (check_in says so to the member who wrote most) after this many.
    static constexpr std::int64_t kDigestMinMessages = 20;
    static constexpr std::int64_t kDigestDueMessages = 60;

    // {conversation_id, summary?, upto_seq?, keep?, drop?, resolve?, restore?}: decides what of
    // a conversation is still read into anybody's context.
    //   summary  the digest: what was said up to message `upto_seq` (default: the
    //            last one), restructured as the writer sees fit. Readers that are
    //            behind get it in place of those messages. A new range needs
    //            kDigestMinMessages messages since the previous digest
    //            (DIGEST_NOT_NEEDED); rewriting the digest of the same range does not.
    //   keep     sequence numbers of messages that stay in front of readers in full
    //            although the digest covers their time.
    //   drop     sequence numbers of messages that are no longer put in front of
    //            anybody (noise, superseded reports). They stay in the history.
    //   resolve  sequence numbers of messages that were dealt with (a request that is
    //            done, a question that was answered): like drop, and marked as
    //            resolved rather than as noise.
    //   restore  sequence numbers that are neither kept, dropped nor resolved any more.
    // `session` is the member doing it (null: the operator at the console). A
    // member can neither drop nor resolve what the operator wrote. `by` names the writer. Fails
    // COMPACT_DISABLED when the operator switched this off for agents.
    json compact(const Session* session, const json& args, const std::string& by);

    // What compacting did to a conversation, newest first: [{at, by, upto_seq,
    // digest_bytes, kept, dropped, resolved, restored}]. From the event log; it
    // holds no text of the conversation.
    json compactions(std::string_view conversation_id);

    // {text, upto_seq, written_at, by}, or null when the conversation has none.
    json digest(std::string_view conversation_id);

    // Every digest the conversation was given, newest first: [{digest_id, text,
    // upto_seq, written_at, by, current}]. `current` marks the one readers get.
    json digests(std::string_view conversation_id);

    // The operator puts digest `digest_id` of this conversation in use in place of
    // the current one. Readers that are behind are shown it once, like a new one.
    // Fails NOT_FOUND for a digest of another conversation.
    json use_digest(std::string_view conversation_id, std::int64_t digest_id);

    // Whether `session` (and, when known, its window) is the one to write the
    // next digest: enough was said since the last one, and it wrote most of it.
    bool digest_due(const Session& session, std::string_view conversation_id, const std::string* window_id);
    json list_all();
    json list_projects();

    // Agent views: only conversations where the caller is a current member.
    json list_for_session(const Session& session);
    json get_for_session(const Session& session, std::string_view conversation_id);

    // Membership gates. A conversation the caller is not a member of is reported
    // as NOT_MEMBER whether or not it exists, so existence does not leak.
    Access require_member(const Session& session, std::string_view conversation_id);
    Access require_reader(const Session& session, std::string_view conversation_id);
    Access require_writer(const Session& session, std::string_view conversation_id);

    // Current members with read permission, for recipient resolution.
    std::vector<std::string> readers(std::string_view conversation_id);

    // Operator: set or clear the overall goal every member sees. {goal?}
    json set_goal(std::string_view conversation_id, const json& args);

    // Agent: ask for a new conversation in the caller's own project.
    //   {task_code, title, purpose?, goal?, member_session_ids?}
    // Nothing is created until the operator approves; the proposer is always a member.
    json propose(const Session& session, const json& args);

    // Operator: pending proposals first, then decided ones, newest first.
    json list_proposals();

    // Agent: the caller's own proposals and what became of them.
    json proposals_of(const Session& session);

    // Operator: approve (creates the conversation and its members) or reject. Idempotent.
    json decide_proposal(std::string_view proposal_id, bool approve);

    // Agent: other usable sessions in the caller's project, so it can address them.
    json roster(const Session& session);

    // Default interconnection. The lobby is the one conversation of a project
    // that every linked session belongs to; it is created on first use.
    // join_lobby adds the session when it has never been a member.
    void join_lobby(const Session& session);

    // Agent: the private conversation between the caller and one other linked
    // session of the same project, created on first use. Only the two of them
    // are members.
    json direct(const Session& session, std::string_view peer_session_id);

    // Operator switched a session's link: off removes it from the lobby and from
    // direct conversations (history stays); on puts it back into the lobby.
    void apply_link(std::string_view session_id, bool linked);

private:
    json conversation_row(std::string_view conversation_id);
    json member_rows(std::string_view conversation_id);
    json proposal_row(std::string_view proposal_id);
    std::string ensure_lobby(std::string_view project_id);
    void add_member(std::string_view conversation_id, std::string_view session_id);

    Database& database_;
    EventLog& events_;
    // Deletes messages selected by `filter` (a WHERE clause over messages m bound
    // to `conversation_id` and, when given, `before`) with everything that hangs on them.
    std::int64_t delete_messages(std::string_view conversation_id, const std::optional<std::string>& before);

    Clock clock_;
};

}  // namespace acm
