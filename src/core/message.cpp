#include "message.hpp"

#include "crypto.hpp"
#include "settings.hpp"

#include <algorithm>
#include <format>
#include <set>

namespace acm {

namespace {

constexpr std::size_t kMaxBodyBytes = 64 * 1024;
constexpr std::int64_t kDefaultPage = 50;
constexpr std::int64_t kMaxPage = 200;

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

bool is_agent_kind(std::string_view kind) {
    static constexpr std::string_view allowed[] = {"message", "handoff", "progress", "artifact", "decision"};
    return std::ranges::find(allowed, kind) != std::end(allowed);
}

// Stable digest of everything that defines "the same request" for a retry.
std::string request_hash(const Draft& draft, const std::vector<std::string>& recipients) {
    json canonical = {{"conversation_id", draft.conversation_id},
                      {"kind", draft.kind},
                      {"body", draft.body},
                      {"payload", draft.fingerprint.is_null() ? draft.payload : draft.fingerprint},
                      {"recipients", recipients},
                      {"reply_to", nullable(draft.reply_to_message_id)}};
    if (draft.urgent) {
        // Only present when set, so requests stored before the flag existed keep their digest.
        canonical["urgent"] = true;
    }
    if (!draft.to_windows.empty()) {
        std::vector<std::string> targets;
        for (const auto& window : draft.to_windows) {
            targets.push_back(window.window_id);
        }
        std::ranges::sort(targets);
        canonical["to_windows"] = targets;
    }
    return sha256_hex(canonical.dump());
}

}  // namespace

json Messages::send(const Session& session, const json& args, const Window* window, std::vector<Window> to_windows) {
    Draft draft;
    if (window != nullptr) {
        draft.author_window_id = window->window_id;
    }
    draft.to_windows = std::move(to_windows);
    draft.conversation_id = require_string(args, "conversation_id", 96);
    draft.body = require_string(args, "body", kMaxBodyBytes);
    draft.kind = optional_string(args, "kind", 32).value_or("message");
    draft.recipient_session_ids = optional_string_list(args, "recipient_session_ids");
    draft.reply_to_message_id = optional_string(args, "reply_to_message_id", 96);
    draft.idempotency_key = require_string(args, "idempotency_key", 128);
    draft.urgent = optional_bool(args, "urgent", false);
    return submit({.session = &session}, draft);
}

json Messages::send_as_operator(const json& args, std::vector<Window> to_windows) {
    Draft draft;
    draft.to_windows = std::move(to_windows);
    draft.conversation_id = require_string(args, "conversation_id", 96);
    draft.body = require_string(args, "body", kMaxBodyBytes);
    draft.kind = optional_string(args, "kind", 32).value_or("message");
    draft.recipient_session_ids = optional_string_list(args, "recipient_session_ids");
    draft.reply_to_message_id = optional_string(args, "reply_to_message_id", 96);
    draft.idempotency_key = optional_string(args, "idempotency_key", 128);
    draft.urgent = optional_bool(args, "urgent", false);
    return submit({}, draft);
}

json Messages::submit(const Author& author, const Draft& draft,
                      const std::function<void(const std::string& message_id)>& attach) {
    if (!is_agent_kind(draft.kind)) {
        fail("INVALID_ARGUMENT",
             std::format("kind {} is not allowed; use message, handoff, progress, artifact or decision", draft.kind));
    }
    const std::string sender_kind = author.session != nullptr ? "agent" : "operator";
    const std::string sender_id = author.session != nullptr ? author.session->session_id : std::string();

    std::vector<std::string> explicit_recipients = draft.recipient_session_ids;
    std::ranges::sort(explicit_recipients);
    if (std::ranges::adjacent_find(explicit_recipients) != explicit_recipients.end()) {
        fail("INVALID_ARGUMENT", "recipient_session_ids contains a duplicate");
    }
    if (author.session != nullptr && std::ranges::binary_search(explicit_recipients, sender_id)) {
        fail("INVALID_ARGUMENT", "a session cannot address a message to itself");
    }
    const std::string hash = request_hash(draft, explicit_recipients);
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);

    // A conflicting retry is detected inside the transaction and reported after it ends.
    std::string conflicting_message;
    bool replay = false;
    bool duplicate = false;
    bool urgent = draft.urgent;
    bool downgraded = false;
    const std::string message_id = database_.transaction([&]() -> std::string {
        std::string project_id;
        if (author.session != nullptr) {
            project_id = conversations_.require_writer(*author.session, draft.conversation_id).project_id;
        } else {
            Statement row = database_.query("SELECT project_id, status FROM conversations WHERE conversation_id = ?",
                                            draft.conversation_id);
            if (!row.step()) {
                fail("NOT_FOUND", std::format("conversation {} does not exist", draft.conversation_id));
            }
            if (row.text(1) == "archived") {
                fail("CONVERSATION_ARCHIVED", "this conversation is archived; restore it before writing to it",
                     {{"conversation_id", draft.conversation_id}});
            }
            project_id = row.text(0);
        }

        if (draft.idempotency_key) {
            Statement prior = database_.query(
                "SELECT message_id, request_hash FROM messages WHERE sender_kind = ? AND "
                "COALESCE(sender_session_id, '') = ? AND idempotency_key = ?",
                sender_kind, sender_id, *draft.idempotency_key);
            if (prior.step()) {
                if (prior.text(1) != hash) {
                    conflicting_message = prior.text(0);
                    return {};
                }
                replay = true;
                return prior.text(0);
            }
        }

        // Flood control for what sessions write to each other; the operator is not limited.
        if (author.session != nullptr) {
            const MessageLimits limits = message_limits(database_);
            const bool conversational = draft.kind == "message" || draft.kind == "handoff" || draft.kind == "decision";
            if (conversational && limits.duplicate_window_seconds > 0) {
                // The same text to the same readers again, under a new key: sessions
                // echoing each other produce exactly this, and one copy is enough.
                Statement same = database_.query(
                    "SELECT message_id FROM messages WHERE sender_session_id = ? AND request_hash = ? AND "
                    "created_at > ? ORDER BY created_at DESC LIMIT 1",
                    sender_id, hash, to_rfc3339(moment - std::chrono::seconds(limits.duplicate_window_seconds)));
                if (same.step()) {
                    duplicate = true;
                    return same.text(0);
                }
            }
            if (!author.session->rate_exempt) {
                enforce_rate(database_, "messages", "sender_session_id", sender_id, moment, "messages");
                if (urgent && limits.urgent_per_hour > 0) {
                    // Sessions marking everything urgent would interrupt each other in a
                    // circle. Past the limit the message still goes out, as an ordinary one.
                    Statement marked = database_.query(
                        "SELECT COUNT(*) FROM messages WHERE sender_session_id = ? AND urgent = 1 AND created_at > ?",
                        sender_id, to_rfc3339(moment - std::chrono::hours(1)));
                    marked.step();
                    if (marked.integer(0) >= limits.urgent_per_hour) {
                        urgent = false;
                        downgraded = true;
                    }
                }
            }
        }

        const std::vector<std::string> readers = conversations_.readers(draft.conversation_id);
        std::vector<std::string> recipients;
        if (explicit_recipients.empty()) {
            for (const auto& reader : readers) {
                if (reader != sender_id) {
                    recipients.push_back(reader);
                }
            }
        } else {
            for (const auto& recipient : explicit_recipients) {
                if (!std::ranges::binary_search(readers, recipient)) {
                    fail("INVALID_RECIPIENT",
                         std::format("session {} is not a reading member of this conversation", recipient),
                         {{"session_id", recipient}});
                }
            }
            recipients = explicit_recipients;
        }

        // A window can only be told what its session may read. Another window of the
        // writer's own application is such a window: that is how two conversations of
        // one application hand work to each other.
        for (const auto& target : draft.to_windows) {
            const bool sibling = author.session != nullptr && target.session_id == author.session->session_id;
            if (!sibling && std::ranges::find(recipients, target.session_id) == recipients.end()) {
                fail("INVALID_RECIPIENT",
                     std::format("window {} belongs to a session that is not a reader of this message", target.name),
                     {{"window", target.name}, {"session_id", target.session_id}});
            }
        }

        if (draft.reply_to_message_id) {
            Statement parent = database_.query(
                "SELECT m.directed, m.sender_session_id FROM messages m WHERE m.message_id = ? AND "
                "m.conversation_id = ?",
                *draft.reply_to_message_id, draft.conversation_id);
            bool visible = parent.step();
            if (visible && author.session != nullptr && parent.integer(0) != 0 &&
                parent.optional_text(1) != std::optional<std::string>(sender_id)) {
                visible = database_
                              .query("SELECT 1 FROM message_recipients WHERE message_id = ? AND session_id = ?",
                                     *draft.reply_to_message_id, sender_id)
                              .step();
            }
            if (!visible) {
                fail("NOT_FOUND", std::format("message {} is not visible in this conversation",
                                              *draft.reply_to_message_id));
            }
        }

        Statement next = database_.query("SELECT next_seq FROM conversations WHERE conversation_id = ?",
                                         draft.conversation_id);
        next.step();
        const std::int64_t seq = next.integer(0);
        database_.execute("UPDATE conversations SET next_seq = next_seq + 1 WHERE conversation_id = ?",
                          draft.conversation_id);

        const std::string id = new_id("msg");
        database_.execute(
            "INSERT INTO messages (message_id, conversation_id, seq, sender_kind, sender_session_id, kind, body, "
            "payload, reply_to_message_id, directed, idempotency_key, request_hash, created_at, urgent, "
            "author_window_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, draft.conversation_id, seq, sender_kind,
            author.session != nullptr ? std::optional<std::string>(sender_id) : std::nullopt, draft.kind, draft.body,
            draft.payload.is_null() ? std::optional<std::string>() : std::optional<std::string>(draft.payload.dump()),
            draft.reply_to_message_id, !explicit_recipients.empty(), draft.idempotency_key, hash, now, urgent,
            draft.author_window_id);
        for (const auto& target : draft.to_windows) {
            database_.execute("INSERT INTO message_windows (message_id, window_id) VALUES (?, ?)", id, target.window_id);
        }
        for (const auto& recipient : recipients) {
            database_.execute(
                "INSERT INTO message_recipients (message_id, session_id, status) VALUES (?, ?, 'available')", id,
                recipient);
        }
        if (attach) {
            attach(id);
        }
        // The event names who may see the message but never carries the body.
        events_.append("message.created",
                       {.project_id = project_id,
                        .conversation_id = draft.conversation_id,
                        .actor_id = author.session != nullptr ? std::optional<std::string>(sender_id) : std::nullopt,
                        .correlation_id = draft.reply_to_message_id},
                       id,
                       {{"message_id", id},
                        {"seq", seq},
                        {"kind", draft.kind},
                        {"sender_kind", sender_kind},
                        {"urgent", urgent},
                        {"directed", !explicit_recipients.empty()},
                        {"recipient_session_ids", recipients}});
        return id;
    });

    if (!conflicting_message.empty()) {
        fail("IDEMPOTENCY_CONFLICT",
             "this idempotency_key was already used for a different request; use a new key for a new message",
             {{"message_id", conflicting_message}});
    }
    json result = message_view(message_id, author.session);
    result["idempotent_replay"] = replay;
    // True when this text was already sent a moment ago and no second copy was stored.
    result["duplicate_suppressed"] = duplicate;
    // True when the urgent mark was dropped because this session used up its hourly number of them.
    result["urgent_downgraded"] = downgraded;
    if (result.value("urgent", false) && result.at("to_windows").empty() && !result.value("directed", false) &&
        conversations_.get(draft.conversation_id).value("kind", std::string()) != "direct") {
        // An urgent message interrupts whom it names. This one names nobody.
        result["urgent_note"] =
            "This urgent message names no window and no session, so it interrupts nobody: every reader sees it "
            "with their next prompt. To have one conversation act on it now, send it with to_windows.";
    }
    // P1 stores and shares only. Pushing into a running turn needs an approved delivery (P2/P3).
    result["delivery"] = {{"action", "shared_only"}, {"approval", "not_required"}};
    return result;
}

json Messages::read(const Session& session, const json& args) {
    const auto conversation_id = require_string(args, "conversation_id", 96);
    const auto after_seq = optional_integer(args, "after_seq", 0, 0, INT64_MAX);
    const auto limit = optional_integer(args, "limit", kDefaultPage, 1, kMaxPage);
    return database_.transaction([&] {
        const Access access = conversations_.require_reader(session, conversation_id);
        std::vector<std::pair<std::string, std::int64_t>> page;
        Statement rows = database_.query(
            "SELECT m.message_id, m.seq FROM messages m WHERE m.conversation_id = ? AND m.seq > ? AND "
            "(m.directed = 0 OR m.sender_session_id = ? OR EXISTS (SELECT 1 FROM message_recipients r "
            "WHERE r.message_id = m.message_id AND r.session_id = ?)) ORDER BY m.seq LIMIT ?",
            conversation_id, after_seq, session.session_id, session.session_id, limit + 1);
        while (rows.step()) {
            page.emplace_back(rows.text(0), rows.integer(1));
        }
        const bool has_more = static_cast<std::int64_t>(page.size()) > limit;
        if (has_more) {
            page.pop_back();
        }
        Statement last = database_.query("SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?",
                                         conversation_id);
        last.step();
        const std::int64_t last_seq = last.integer(0);

        std::vector<std::string> ids;
        for (const auto& entry : page) {
            ids.push_back(entry.first);
        }
        mark_read(session, ids, conversation_id, access.project_id);
        json messages = json::array();
        for (const auto& id : ids) {
            messages.push_back(message_view(id, &session));
        }
        // With nothing further visible the cursor jumps to the end, past messages
        // hidden from this caller, and never beyond it: an after_seq larger than
        // anything stored must not make later messages look already read.
        const std::int64_t next_cursor = has_more ? page.back().second : last_seq;
        return json{{"conversation_id", conversation_id},
                    {"messages", messages},
                    {"next_cursor", next_cursor},
                    {"has_more", has_more},
                    {"last_seq", last_seq}};
    });
}

json Messages::inbox(const Session& session, const json& args) {
    const auto only_conversation = optional_string(args, "conversation_id", 96);
    const auto limit = optional_integer(args, "limit", kDefaultPage, 1, kMaxPage);
    return database_.transaction([&] {
        struct Pending {
            std::string message_id;
            std::string conversation_id;
            std::string project_id;
        };
        std::vector<Pending> pending;
        // Only conversations the caller can still read; losing membership hides the backlog.
        Statement rows = database_.query(
            "SELECT m.message_id, m.conversation_id, c.project_id FROM message_recipients r "
            "JOIN messages m ON m.message_id = r.message_id "
            "JOIN conversations c ON c.conversation_id = m.conversation_id AND c.status = 'open' "
            "JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.session_id = r.session_id "
            "WHERE r.session_id = ? AND r.status <> 'acknowledged' AND cm.removed_at IS NULL AND cm.can_read = 1 "
            // What compacting dropped or resolved is no longer anybody's to answer.
            "AND m.context >= 0 "
            "AND (? IS NULL OR m.conversation_id = ?) ORDER BY m.created_at, m.conversation_id, m.seq LIMIT ?",
            session.session_id, only_conversation, only_conversation, limit + 1);
        while (rows.step()) {
            pending.push_back({rows.text(0), rows.text(1), rows.text(2)});
        }
        const bool has_more = static_cast<std::int64_t>(pending.size()) > limit;
        if (has_more) {
            pending.pop_back();
        }
        json items = json::array();
        for (const auto& entry : pending) {
            mark_read(session, {entry.message_id}, entry.conversation_id, entry.project_id);
            items.push_back(message_view(entry.message_id, &session));
        }
        return json{{"items", items}, {"has_more", has_more}};
    });
}

json Messages::acknowledge(const Session& session, const json& args) {
    const auto message_id = require_string(args, "message_id", 96);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement row = database_.query(
            "SELECT m.conversation_id, r.status FROM message_recipients r JOIN messages m ON m.message_id = "
            "r.message_id WHERE r.message_id = ? AND r.session_id = ?",
            message_id, session.session_id);
        if (!row.step()) {
            fail("NOT_RECIPIENT",
                 std::format("message {} does not exist or is not addressed to this session", message_id),
                 {{"message_id", message_id}});
        }
        const auto conversation_id = row.text(0);
        const bool already = row.text(1) == "acknowledged";
        const Access access = conversations_.require_reader(session, conversation_id);
        if (!already) {
            database_.execute(
                "UPDATE message_recipients SET status = 'acknowledged', acknowledged_at = ?, "
                "read_at = COALESCE(read_at, ?) WHERE message_id = ? AND session_id = ?",
                now, now, message_id, session.session_id);
            events_.append("message.acknowledged",
                           {.project_id = access.project_id,
                            .conversation_id = conversation_id,
                            .actor_id = session.session_id},
                           message_id, {{"message_id", message_id}, {"session_id", session.session_id}});
        }
        Statement receipt = database_.query(
            "SELECT status, read_at, acknowledged_at FROM message_recipients WHERE message_id = ? AND session_id = ?",
            message_id, session.session_id);
        receipt.step();
        return json{{"message_id", message_id},
                    {"conversation_id", conversation_id},
                    {"session_id", session.session_id},
                    {"status", receipt.text(0)},
                    {"read_at", nullable(receipt.optional_text(1))},
                    {"acknowledged_at", nullable(receipt.optional_text(2))},
                    {"already_acknowledged", already}};
    });
}

json Messages::read_all(std::string_view conversation_id, const json& args) {
    const auto after_seq = optional_integer(args, "after_seq", 0, 0, INT64_MAX);
    const auto limit = optional_integer(args, "limit", kDefaultPage, 1, kMaxPage);
    Statement exists = database_.query("SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?",
                                       conversation_id);
    if (!exists.step()) {
        fail("NOT_FOUND", std::format("conversation {} does not exist", conversation_id));
    }
    const std::int64_t last_seq = exists.integer(0);
    std::vector<std::pair<std::string, std::int64_t>> page;
    Statement rows = database_.query(
        "SELECT message_id, seq FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        conversation_id, after_seq, limit + 1);
    while (rows.step()) {
        page.emplace_back(rows.text(0), rows.integer(1));
    }
    const bool has_more = static_cast<std::int64_t>(page.size()) > limit;
    if (has_more) {
        page.pop_back();
    }
    json messages = json::array();
    for (const auto& entry : page) {
        messages.push_back(message_view(entry.first, nullptr));
    }
    return {{"conversation_id", conversation_id},
            {"messages", messages},
            {"next_cursor", page.empty() ? after_seq : page.back().second},
            {"has_more", has_more},
            {"last_seq", last_seq}};
}

json Messages::forward(const Session& session, const json& args) {
    const auto message_id = require_string(args, "message_id", 96);
    const auto note = optional_string(args, "note", 4000);
    Draft draft;
    draft.recipient_session_ids = optional_string_list(args, "recipient_session_ids");
    draft.idempotency_key = require_string(args, "idempotency_key", 128);
    const auto target = optional_string(args, "to_conversation_id", 96);

    Statement source = database_.query(
        "SELECT m.conversation_id, m.body, m.directed, m.sender_session_id, m.created_at, m.sender_kind, s.label, "
        "a.display_name, c.task_code FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id "
        "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
        "LEFT JOIN agents a ON a.agent_id = s.agent_id WHERE m.message_id = ?",
        message_id);
    // A message the caller may not read is indistinguishable from one that does not exist.
    const auto hidden = [&] {
        fail("NOT_FOUND", std::format("message {} does not exist or is not visible to this session", message_id));
    };
    if (!source.step()) {
        hidden();
    }
    const auto source_conversation = source.text(0);
    const bool can_read = database_
                              .query("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND "
                                     "session_id = ? AND removed_at IS NULL AND can_read = 1",
                                     source_conversation, session.session_id)
                              .step();
    const bool own = source.optional_text(3) == std::optional<std::string>(session.session_id);
    const bool addressed = database_
                               .query("SELECT 1 FROM message_recipients WHERE message_id = ? AND session_id = ?",
                                      message_id, session.session_id)
                               .step();
    if (!can_read || (source.integer(2) != 0 && !own && !addressed)) {
        hidden();
    }

    draft.conversation_id = target.value_or(source_conversation);
    draft.kind = "message";
    draft.body = source.text(1);
    draft.payload = {{"forwarded",
                      {{"message_id", message_id},
                       {"conversation_id", source_conversation},
                       {"task_code", source.text(8)},
                       {"sender_kind", source.text(5)},
                       {"sender_display_name", nullable(source.optional_text(7))},
                       {"sender_label", nullable(source.optional_text(6))},
                       {"sent_at", source.text(4)},
                       {"note", nullable(note)}}}};
    return submit({.session = &session}, draft, [&](const std::string& copy_id) {
        database_.execute("UPDATE messages SET forwarded_from = ? WHERE message_id = ?", message_id, copy_id);
    });
}

json Messages::unread(const Session& session, std::string_view conversation_id, std::int64_t limit,
                      const Window* window) {
    conversations_.require_reader(session, conversation_id);
    // A window reads from its own place. It got one for every conversation of its
    // session when it was first seen; a conversation it has no place in yet was
    // joined later and is new to it from the start.
    Statement cursor = database_.query(
        "SELECT CASE WHEN ?2 IS NULL THEN "
        "(SELECT read_seq FROM conversation_members WHERE conversation_id = ?1 AND session_id = ?3) ELSE "
        "COALESCE((SELECT read_seq FROM window_cursors WHERE window_id = ?2 AND conversation_id = ?1), 0) END",
        conversation_id, window != nullptr ? std::optional<std::string>(window->window_id) : std::nullopt,
        session.session_id);
    cursor.step();
    const std::int64_t read_upto = cursor.integer(0);
    Statement place = database_.query(
        "SELECT next_seq - 1, digest_seq, kind FROM conversations WHERE conversation_id = ?", conversation_id);
    place.step();
    const std::int64_t last = place.integer(0);
    const std::int64_t digest_seq = place.integer(1);
    const bool direct = place.text(2) == "direct";
    // The newest `limit`, after the digest when that covers more.
    std::int64_t start = std::max(read_upto, last - limit);
    const bool digested = digest_seq > read_upto;
    if (digested) {
        start = std::max(start, digest_seq);
    }
    json page = read(session, {{"conversation_id", std::string(conversation_id)},
                               {"after_seq", start},
                               {"limit", limit}});
    advance_cursor(session, conversation_id, page.at("next_cursor").get<std::int64_t>(), window);
    if (digested) {
        page["digest"] = conversations_.digest(conversation_id);
    }
    // Messages from before `start` that compacting kept in front of readers: they come along in full.
    if (start > read_upto) {
        json kept = json::array();
        Statement rows = database_.query(
            "SELECT m.message_id FROM messages m WHERE m.conversation_id = ?1 AND m.seq > ?2 AND m.seq <= ?3 "
            "AND m.context = 1 AND COALESCE(m.sender_session_id, '') <> ?4 AND (m.directed = 0 OR EXISTS "
            "(SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id AND r.session_id = ?4)) "
            "ORDER BY m.seq LIMIT 40",
            conversation_id, read_upto, start, session.session_id);
        std::vector<std::string> ids;
        while (rows.step()) {
            ids.push_back(rows.text(0));
        }
        for (const auto& id : ids) {
            kept.push_back(message_view(id, &session));
        }
        if (!kept.empty()) {
            page["kept_messages"] = std::move(kept);
        }
    }
    // Left out without a digest to stand for them.
    page["skipped_earlier"] = std::max<std::int64_t>(0, start - std::max(read_upto, digest_seq));
    // The caller already knows what it sent itself. What another window of the
    // same session wrote is news to it, as far as the two can be told apart.
    json others = json::array();
    for (auto& message : page.at("messages")) {
        const bool same_session = message.at("sender").at("session_id") == json(session.session_id);
        const json& author = message.at("from_window");
        const bool told_apart = window != nullptr && !author.is_null();
        const bool own = same_session && (!told_apart || author.at("window_id") == json(window->window_id));
        if (own) {
            continue;
        }
        // Dropped by compacting: not read into anybody's context. read_messages still shows it.
        if (message.at("context") == json("dropped") || message.at("context") == json("resolved")) {
            continue;
        }
        // In full when it is for this reader: its window is named, it is for its session
        // alone, or this is its direct conversation. Otherwise an overview is enough here.
        const bool named = window != nullptr && std::ranges::any_of(message.at("to_windows"), [&](const json& target) {
            return target.at("window_id") == json(window->window_id);
        });
        // An urgent message that names other windows is theirs, not this reader's.
        const bool for_reader = named || direct || message.value("directed", false) ||
                                (message.value("urgent", false) && message.at("to_windows").empty()) ||
                                message.at("context") == json("kept");
        if (!for_reader && message.at("body").is_string()) {
            std::string body = message.at("body").get<std::string>();
            if (body.size() > kOverviewBytes) {
                std::size_t end = kOverviewBytes;
                while (end > 0 && (static_cast<unsigned char>(body[end]) & 0xC0) == 0x80) {
                    --end;
                }
                body.resize(end);
                message["body"] = body + " [... cut; read_messages has the rest]";
                message["cut"] = true;
            }
        }
        others.push_back(std::move(message));
    }
    page["messages"] = std::move(others);
    return page;
}

void Messages::advance_cursor(const Session& session, std::string_view conversation_id, std::int64_t sequence,
                              const Window* window) {
    if (window != nullptr) {
        database_.execute(
            "INSERT INTO window_cursors (window_id, conversation_id, read_seq) VALUES (?1, ?2, "
            "MIN(?3, (SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?2))) "
            "ON CONFLICT (window_id, conversation_id) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq)",
            window->window_id, conversation_id, sequence);
    } else {
        // Which of the session's windows read this is not known, so it may have been
        // any of them: none is shown it again.
        database_.execute(
            "INSERT INTO window_cursors (window_id, conversation_id, read_seq) "
            "SELECT window_id, ?2, MIN(?3, (SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?2)) "
            "FROM windows WHERE session_id = ?1 "
            "ON CONFLICT (window_id, conversation_id) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq)",
            session.session_id, conversation_id, sequence);
    }
    database_.execute(
        "UPDATE conversation_members SET read_seq = MIN(MAX(read_seq, ?), "
        "(SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?)) "
        "WHERE conversation_id = ? AND session_id = ?",
        sequence, conversation_id, conversation_id, session.session_id);
}

std::int64_t Messages::pending_count(const Session& session) {
    Statement row = database_.query(
        "SELECT COUNT(*) FROM message_recipients r JOIN messages m ON m.message_id = r.message_id "
        "JOIN conversations c ON c.conversation_id = m.conversation_id AND c.status = 'open' "
        "JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.session_id = r.session_id "
        "WHERE r.session_id = ? AND r.status <> 'acknowledged' AND cm.removed_at IS NULL AND cm.can_read = 1 "
        "AND m.context >= 0",
        session.session_id);
    row.step();
    return row.integer(0);
}

void Messages::mark_read(const Session& session, const std::vector<std::string>& message_ids,
                         std::string_view conversation_id, std::string_view project_id) {
    const auto now = to_rfc3339(clock_());
    for (const auto& message_id : message_ids) {
        const auto changed = database_.execute(
            "UPDATE message_recipients SET status = 'read', read_at = ? WHERE message_id = ? AND session_id = ? "
            "AND status = 'available'",
            now, message_id, session.session_id);
        if (changed > 0) {
            events_.append("message.read",
                           {.project_id = std::string(project_id),
                            .conversation_id = std::string(conversation_id),
                            .actor_id = session.session_id},
                           message_id, {{"message_id", message_id}, {"session_id", session.session_id}});
        }
    }
}

json Messages::receipts(std::string_view message_id) {
    json list = json::array();
    Statement rows = database_.query(
        "SELECT session_id, status, read_at, acknowledged_at FROM message_recipients WHERE message_id = ? "
        "ORDER BY session_id",
        message_id);
    while (rows.step()) {
        list.push_back({{"session_id", rows.text(0)},
                        {"status", rows.text(1)},
                        {"read_at", nullable(rows.optional_text(2))},
                        {"acknowledged_at", nullable(rows.optional_text(3))}});
    }
    return list;
}

json Messages::message_view(std::string_view message_id, const Session* viewer) {
    Statement row = database_.query(
        "SELECT m.message_id, m.conversation_id, m.seq, m.sender_kind, m.sender_session_id, m.kind, m.body, "
        "m.payload, m.reply_to_message_id, m.directed, m.created_at, s.agent_id, s.label, a.provider, "
        "a.display_name, m.forwarded_from, m.urgent, m.author_window_id, w.name, m.context FROM messages m "
        "LEFT JOIN agent_sessions s ON s.session_id = m.sender_session_id "
        "LEFT JOIN agents a ON a.agent_id = s.agent_id "
        "LEFT JOIN windows w ON w.window_id = m.author_window_id WHERE m.message_id = ?",
        message_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("message {} does not exist", message_id));
    }
    json view = {{"message_id", row.text(0)},
                 {"conversation_id", row.text(1)},
                 {"sequence", row.integer(2)},
                 {"kind", row.text(5)},
                 {"body", row.text(6)},
                 {"payload", row.is_null(7) ? json(nullptr) : json::parse(row.text(7))},
                 {"reply_to_message_id", nullable(row.optional_text(8))},
                 {"directed", row.integer(9) != 0},
                 {"urgent", row.integer(16) != 0},
                 {"forwarded_from", nullable(row.optional_text(15))},
                 {"created_at", row.text(10)},
                 {"sender",
                  {{"kind", row.text(3)},
                   {"session_id", nullable(row.optional_text(4))},
                   {"agent_id", nullable(row.optional_text(11))},
                   {"label", nullable(row.optional_text(12))},
                   {"provider", nullable(row.optional_text(13))},
                   {"display_name", nullable(row.optional_text(14))}}}};
    // The window that wrote it, when known, and the windows it is meant for; empty means all of them.
    // Whether compacting kept it in front of readers, or took it out of what is read into a context.
    view["context"] = row.integer(19) > 0     ? json("kept")
                      : row.integer(19) == -2 ? json("resolved")
                      : row.integer(19) < 0   ? json("dropped")
                                              : json(nullptr);
    view["from_window"] = row.is_null(17) ? json(nullptr)
                                          : json{{"window_id", row.text(17)}, {"name", row.optional_text(18).value_or("")}};
    json targets = json::array();
    Statement meant = database_.query(
        "SELECT t.window_id, w.name FROM message_windows t JOIN windows w ON w.window_id = t.window_id "
        "WHERE t.message_id = ? ORDER BY w.name",
        message_id);
    while (meant.step()) {
        targets.push_back({{"window_id", meant.text(0)}, {"name", meant.text(1)}});
    }
    view["to_windows"] = std::move(targets);
    const json all = receipts(message_id);
    const bool viewer_is_sender =
        viewer != nullptr && view.at("sender").at("session_id") == json(viewer->session_id);
    if (viewer == nullptr || viewer_is_sender) {
        // The operator and the sender see every recipient's receipt.
        view["recipients"] = all;
    }
    if (viewer != nullptr) {
        view["your_receipt"] = nullptr;
        for (const auto& receipt : all) {
            if (receipt.at("session_id") == json(viewer->session_id)) {
                view["your_receipt"] = receipt;
            }
        }
    }
    return view;
}

}  // namespace acm
