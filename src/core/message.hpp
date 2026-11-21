// Messages: the single write path into a conversation, visibility-filtered
// reads with a sequence cursor, per-recipient receipts and explicit
// acknowledgement.
//
// Receipt states for one recipient of one message:
//   available     stored and readable by that recipient
//   read          the service returned the body to that recipient's session
//   acknowledged  the recipient explicitly confirmed it
// A page refresh or an HTTP 200 on another path never advances these states.
#pragma once

#include "common.hpp"
#include "conversation.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"
#include "window.hpp"

#include <functional>

namespace acm {

// Who is writing. A null session means the operator console.
struct Author {
    const Session* session = nullptr;
};

// One message to append. Identity is never part of the draft.
struct Draft {
    std::string conversation_id;
    std::string kind = "message";
    std::string body;
    json payload = nullptr;
    // When set, identifies the request for idempotency instead of payload, so values the
    // service derives (hashes, sizes) do not turn a retry into a conflict.
    json fingerprint = nullptr;
    std::vector<std::string> recipient_session_ids;
    std::optional<std::string> reply_to_message_id;
    std::optional<std::string> idempotency_key;
    // Asks for the readers to be interrupted: see delivery.hpp.
    bool urgent = false;
    // Which window of the author's session wrote it, when that is known, and the
    // windows it is meant for. Without targets it is for every window of its readers.
    std::optional<std::string> author_window_id;
    std::vector<Window> to_windows;
};

class Messages {
public:
    Messages(Database& database, EventLog& events, Conversations& conversations, Clock clock)
        : database_(database), events_(events), conversations_(conversations), clock_(std::move(clock)) {}

    // Agent: {conversation_id, body, kind?, recipient_session_ids?, reply_to_message_id?, idempotency_key}.
    // Without recipients the message is shared with every reading member. With
    // recipients only the sender and those sessions can ever see it.
    // `window` is the caller's window when known; `to_windows` the windows the
    // message is meant for (see window.hpp), each of which must belong to a
    // session that can read the message.
    json send(const Session& session, const json& args, const Window* window = nullptr,
              std::vector<Window> to_windows = {});

    // Agent: {conversation_id, after_seq?, limit?} -> messages visible to the caller
    // with seq > after_seq, plus next_cursor, has_more and last_seq.
    json read(const Session& session, const json& args);

    // Agent: {conversation_id?, limit?} -> messages addressed to the caller that
    // it has not acknowledged yet, oldest first.
    json inbox(const Session& session, const json& args);

    // Agent: {message_id}. Only a recipient can acknowledge; repeating is a no-op.
    json acknowledge(const Session& session, const json& args);

    // Agent: pass a message the caller can read on to others.
    //   {message_id, to_conversation_id?, recipient_session_ids?, note?, idempotency_key}
    // The copy keeps the original body and records where it came from, so the
    // receiver can tell a relayed message from a first-hand one.
    json forward(const Session& session, const json& args);

    // Agent: messages after the caller's own read cursor in one conversation,
    // excluding its own, and moves that cursor forward.
    // With a window, the cursor is that window's own: two windows of one session
    // each catch up from where they themselves stopped, and each sees what the
    // other wrote.
    json unread(const Session& session, std::string_view conversation_id, std::int64_t limit,
                const Window* window = nullptr);

    // Moves the caller's read cursor forward; it never moves back.
    void advance_cursor(const Session& session, std::string_view conversation_id, std::int64_t sequence,
                        const Window* window = nullptr);

    // How many messages addressed to the caller it has not acknowledged yet.
    std::int64_t pending_count(const Session& session);

    // Operator: {conversation_id, body, kind?, recipient_session_ids?, idempotency_key?}.
    json send_as_operator(const json& args, std::vector<Window> to_windows = {});

    // Operator: every message with all recipient receipts; {after_seq?, limit?}.
    json read_all(std::string_view conversation_id, const json& args);

    // The one place a message row is created. Applies the membership rules for
    // the author, resolves recipients, enforces idempotency and assigns the
    // sequence in a single transaction. `attach` runs inside that transaction
    // for a newly created message only, so dependent rows commit atomically.
    json submit(const Author& author, const Draft& draft,
                const std::function<void(const std::string& message_id)>& attach = {});

private:
    json message_view(std::string_view message_id, const Session* viewer);
    json receipts(std::string_view message_id);
    void mark_read(const Session& session, const std::vector<std::string>& message_ids,
                   std::string_view conversation_id, std::string_view project_id);

    Database& database_;
    EventLog& events_;
    Conversations& conversations_;
    Clock clock_;
};

}  // namespace acm
