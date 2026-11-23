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

        // Which model writes this. A window is known by its own model and never takes that
        // of another window: windows of one application may run different models.
        std::optional<std::string> model;
        if (draft.author_window_id) {
            Statement own = database_.query("SELECT model FROM windows WHERE window_id = ?", *draft.author_window_id);
            if (own.step()) {
                model = own.optional_text(0);
            }
        } else if (author.session != nullptr) {
            // No window is known for the call (some clients name the conversation only in
            // their hooks). When the windows of this application that were at work in the last
            // minutes all run one model, it is that one; otherwise what the application said itself.
            Statement recent = database_.query(
                "SELECT DISTINCT model FROM windows WHERE session_id = ? AND model IS NOT NULL AND seen_at >= ? LIMIT 2",
                sender_id, to_rfc3339(moment - std::chrono::seconds(180)));
            std::vector<std::string> at_work;
            while (recent.step()) {
                at_work.push_back(recent.text(0));
            }
            if (at_work.size() == 1) {
                model = at_work.front();
            } else {
                Statement said = database_.query("SELECT model FROM agent_sessions WHERE session_id = ?", sender_id);
                if (said.step()) {
                    model = said.optional_text(0);
                }
            }
        }
        const std::string id = new_id("msg");
        database_.execute(
            "INSERT INTO messages (message_id, conversation_id, seq, sender_kind, sender_session_id, kind, body, "
            "payload, reply_to_message_id, directed, idempotency_key, request_hash, created_at, urgent, "
            "author_window_id, author_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, draft.conversation_id, seq, sender_kind,
            author.session != nullptr ? std::optional<std::string>(sender_id) : std::nullopt, draft.kind, draft.body,
            draft.payload.is_null() ? std::optional<std::string>() : std::optional<std::string>(draft.payload.dump()),
            draft.reply_to_message_id, !explicit_recipients.empty(), draft.idempotency_key, hash, now, urgent,
            draft.author_window_id, model);
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

json Messages::by_sender(std::string_view sender, const json& args) {
    const auto limit = optional_integer(args, "limit", 40, 1, 200);
    const auto before = optional_integer(args, "before", INT64_MAX, 1, INT64_MAX);
    // "operator": what was written at the console. Otherwise an agent: all its sessions and windows.
    const bool console = sender == "operator";
    std::vector<std::pair<std::string, std::int64_t>> found;
    Statement rows = console
        ? database_.query("SELECT m.message_id, m.rowid FROM messages m WHERE m.sender_kind = 'operator' AND m.rowid < ? "
                          "ORDER BY m.rowid DESC LIMIT ?",
                          before, limit + 1)
        : database_.query("SELECT m.message_id, m.rowid FROM messages m JOIN agent_sessions s ON s.session_id = "
                          "m.sender_session_id WHERE s.agent_id = ? AND m.rowid < ? ORDER BY m.rowid DESC LIMIT ?",
                          sender, before, limit + 1);
    while (rows.step()) {
        found.emplace_back(rows.text(0), rows.integer(1));
    }
    const bool has_more = static_cast<std::int64_t>(found.size()) > limit;
    if (has_more) {
        found.pop_back();
    }
    json messages = json::array();
    for (const auto& [id, rowid] : found) {
        json view = message_view(id, nullptr);
        // Where it was said, for a list that spans conversations.
        Statement place = database_.query(
            "SELECT kind, title, task_code, status FROM conversations WHERE conversation_id = ?",
            view.at("conversation_id").get<std::string>());
        place.step();
        view["conversation"] = {{"kind", place.text(0)}, {"title", place.text(1)}, {"task_code", place.text(2)}, {"status", place.text(3)}};
        messages.push_back(std::move(view));
    }
    Statement total = console
        ? database_.query("SELECT COUNT(*) FROM messages WHERE sender_kind = 'operator'")
        : database_.query("SELECT COUNT(*) FROM messages m JOIN agent_sessions s ON s.session_id = m.sender_session_id "
                          "WHERE s.agent_id = ?", sender);
    total.step();
    return {{"messages", messages},
            {"has_more", has_more},
            {"next_before", found.empty() ? json(nullptr) : json(found.back().second)},
            {"total", total.integer(0)}};
}

namespace {

// Cuts the text of a message to `allowed` bytes, on a character boundary, and says so.
// Returns how many bytes of text the message now carries.
std::size_t shorten(json& message, std::size_t allowed) {
    if (!message.contains("body") || !message.at("body").is_string()) {
        return 0;
    }
    std::string body = message.at("body").get<std::string>();
    if (body.size() <= allowed) {
        return body.size();
    }
    std::size_t end = allowed;
    while (end > 0 && (static_cast<unsigned char>(body[end]) & 0xC0) == 0x80) {
        --end;
    }
    body.resize(end);
    message["body"] = body + " [... cut; read_messages has the rest]";
    message["cut"] = true;
    return end;
}

// A message as check_in lists it: what a reader acts on. The whole record (the receipts of
// every reader, empty fields, the ids of the agent and its vendor) is what read_messages
// and the console show; here it would be most of what a reader has to take in.
void slim(json& message) {
    for (const char* key : {"payload", "forwarded_from", "reply_to_message_id", "context", "from_window"}) {
        if (message.contains(key) && message.at(key).is_null()) {
            message.erase(key);
        }
    }
    for (const char* key : {"directed", "urgent"}) {
        if (message.contains(key) && message.at(key) == json(false)) {
            message.erase(key);
        }
    }
    message.erase("recipients");
    message.erase("conversation_id");
    if (message.contains("your_receipt")) {
        const bool acknowledged = message.at("your_receipt").is_object() &&
                                  message.at("your_receipt").value("status", std::string()) == "acknowledged";
        message.erase("your_receipt");
        if (acknowledged) {
            message["acknowledged"] = true;
        }
    }
    if (message.contains("sender") && message.at("sender").is_object()) {
        json& sender = message.at("sender");
        sender.erase("agent_id");
        sender.erase("provider");
        for (const char* key : {"model", "label", "display_name", "session_id"}) {
            if (sender.contains(key) && sender.at(key).is_null()) {
                sender.erase(key);
            }
        }
    }
}

}  // namespace

json Messages::page(const Session& session, std::string_view conversation_id, std::int64_t after_seq,
                    std::int64_t limit, std::size_t max_bytes) {
    return database_.transaction([&] {
        const Access access = conversations_.require_reader(session, conversation_id);
        struct Row {
            std::string id;
            std::int64_t seq;
        };
        std::vector<Row> rows_found;
        Statement rows = database_.query(
            "SELECT m.message_id, m.seq, length(CAST(m.body AS BLOB)) FROM messages m WHERE m.conversation_id = ? "
            "AND m.seq > ? AND (m.directed = 0 OR m.sender_session_id = ? OR EXISTS (SELECT 1 FROM message_recipients r "
            "WHERE r.message_id = m.message_id AND r.session_id = ?)) ORDER BY m.seq LIMIT ?",
            conversation_id, after_seq, session.session_id, session.session_id, limit + 1);
        bool has_more = false;
        std::size_t held = 0;
        while (rows.step()) {
            if (static_cast<std::int64_t>(rows_found.size()) == limit) {
                has_more = true;
                break;
            }
            // A page that holds enough text ends here; the next one goes on from next_cursor.
            const auto bytes = static_cast<std::size_t>(rows.integer(2));
            if (max_bytes > 0 && !rows_found.empty() && held + bytes > max_bytes) {
                has_more = true;
                break;
            }
            held += bytes;
            rows_found.push_back({rows.text(0), rows.integer(1)});
        }
        Statement last = database_.query("SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?",
                                         conversation_id);
        last.step();
        const std::int64_t last_seq = last.integer(0);

        std::vector<std::string> ids;
        for (const auto& entry : rows_found) {
            ids.push_back(entry.id);
        }
        mark_read(session, ids, conversation_id, access.project_id);
        json messages = json::array();
        for (const auto& id : ids) {
            messages.push_back(message_view(id, &session));
        }
        // With nothing further visible the cursor jumps to the end, past messages
        // hidden from this caller, and never beyond it: an after_seq larger than
        // anything stored must not make later messages look already read.
        const std::int64_t next_cursor = has_more ? rows_found.back().seq : last_seq;
        return json{{"conversation_id", conversation_id},
                    {"messages", messages},
                    {"next_cursor", next_cursor},
                    {"has_more", has_more},
                    {"last_seq", last_seq}};
    });
}

json Messages::read(const Session& session, const json& args) {
    const auto conversation_id = require_string(args, "conversation_id", 96);
    const auto limit = optional_integer(args, "limit", kDefaultPage, 1, kMaxPage);
    // Single messages, in full: what a reader asks for when it was given an overview.
    if (args.contains("message_ids") && !args.at("message_ids").is_null()) {
        const auto wanted = optional_string_list(args, "message_ids");
        if (wanted.empty() || wanted.size() > 10) {
            fail("INVALID_ARGUMENT", "message_ids takes 1 to 10 message ids");
        }
        return database_.transaction([&] {
            const Access access = conversations_.require_reader(session, conversation_id);
            std::vector<std::string> ids;
            for (const auto& id : wanted) {
                Statement row = database_.query(
                    "SELECT 1 FROM messages m WHERE m.message_id = ? AND m.conversation_id = ? AND (m.directed = 0 OR "
                    "m.sender_session_id = ? OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = "
                    "m.message_id AND r.session_id = ?))",
                    id, conversation_id, session.session_id, session.session_id);
                if (!row.step()) {
                    fail("NOT_FOUND", std::format("message {} is not visible in this conversation", id));
                }
                ids.push_back(id);
            }
            mark_read(session, ids, conversation_id, access.project_id);
            json messages = json::array();
            for (const auto& id : ids) {
                messages.push_back(message_view(id, &session));
            }
            return json{{"conversation_id", conversation_id}, {"messages", messages}, {"by_message_ids", true}};
        });
    }
    if (args.contains("after_seq") && !args.at("after_seq").is_null()) {
        return page(session, conversation_id, optional_integer(args, "after_seq", 0, 0, INT64_MAX), limit, kPageBytes);
    }
    // No place named: the newest messages, as many as fit a page. The beginning of a long
    // conversation is the last thing a reader needs; after_seq 0 still reads from there.
    conversations_.require_reader(session, conversation_id);
    Statement newest = database_.query(
        "SELECT m.seq, length(CAST(m.body AS BLOB)) FROM messages m WHERE m.conversation_id = ? AND (m.directed = 0 OR "
        "m.sender_session_id = ? OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id AND "
        "r.session_id = ?)) ORDER BY m.seq DESC LIMIT ?",
        conversation_id, session.session_id, session.session_id, limit);
    std::int64_t first = 0;
    std::int64_t count = 0;
    std::size_t held = 0;
    while (newest.step()) {
        const auto bytes = static_cast<std::size_t>(newest.integer(1));
        if (count > 0 && held + bytes > kPageBytes) {
            break;
        }
        held += bytes;
        first = newest.integer(0);
        ++count;
    }
    json result = page(session, conversation_id, first > 0 ? first - 1 : 0, limit, 0);
    // Where this page begins, when the conversation has more before it.
    result["first_seq"] = first;
    return result;
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
        // The newest first: what was asked last is what most likely still needs an answer.
        Statement rows = database_.query(
            "SELECT m.message_id, m.conversation_id, c.project_id, length(CAST(m.body AS BLOB)) FROM message_recipients r "
            "JOIN messages m ON m.message_id = r.message_id "
            "JOIN conversations c ON c.conversation_id = m.conversation_id AND c.status = 'open' "
            "JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.session_id = r.session_id "
            "WHERE r.session_id = ? AND r.status <> 'acknowledged' AND cm.removed_at IS NULL AND cm.can_read = 1 "
            // What compacting dropped or resolved is no longer anybody's to answer.
            "AND m.context >= 0 "
            "AND (? IS NULL OR m.conversation_id = ?) ORDER BY m.rowid DESC LIMIT ?",
            session.session_id, only_conversation, only_conversation, limit + 1);
        bool has_more = false;
        std::size_t held = 0;
        while (rows.step()) {
            if (static_cast<std::int64_t>(pending.size()) == limit) {
                has_more = true;
                break;
            }
            // A page that holds enough text ends here; acknowledge what was dealt with to see the rest.
            const auto bytes = static_cast<std::size_t>(rows.integer(3));
            if (!pending.empty() && held + bytes > kPageBytes) {
                has_more = true;
                break;
            }
            held += bytes;
            pending.push_back({rows.text(0), rows.text(1), rows.text(2)});
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

json Messages::waiting_view(const Session& session, const std::vector<std::string>& ids, const Window* window) {
    json waiting = json::array();
    std::size_t left = kWaitingTotalBytes;
    for (const auto& id : ids) {
        const json view = message_view(id, &session);
        Statement place = database_.query("SELECT kind, title FROM conversations WHERE conversation_id = ?",
                                          view.at("conversation_id").get<std::string>());
        place.step();
        const std::string kind = place.text(0);
        const bool named = window != nullptr && std::ranges::any_of(view.at("to_windows"), [&](const json& target) {
            return target.at("window_id") == json(window->window_id);
        });
        json entry = {{"message_id", view.at("message_id")},
                      {"conversation_id", view.at("conversation_id")},
                      {"in", kind == "lobby" ? json("the lobby") : kind == "direct" ? json("a direct conversation with you") : json(place.text(1))},
                      {"why", named ? "it names your window" : kind == "direct" ? "it is a direct message to you" : "it was sent to your session alone"},
                      {"sequence", view.at("sequence")},
                      {"created_at", view.at("created_at")},
                      {"urgent", view.at("urgent")},
                      {"from",
                       {{"kind", view.at("sender").at("kind")},
                        {"session_id", view.at("sender").at("session_id")},
                        {"display_name", view.at("sender").at("display_name")},
                        {"label", view.at("sender").at("label")},
                        {"window", view.at("from_window").is_null() ? json(nullptr) : view.at("from_window").at("name")}}}};
        std::string body = view.at("body").get<std::string>();
        const std::size_t allowed = std::max(kWaitingReminderBytes, std::min(kWaitingBytes, left));
        left -= std::min(left, std::min(body.size(), allowed));
        if (body.size() > allowed) {
            std::size_t end = allowed;
            while (end > 0 && (static_cast<unsigned char>(body[end]) & 0xC0) == 0x80) {
                --end;
            }
            body.resize(end);
            body += " [... cut; read_messages has the rest]";
            entry["cut"] = true;
        }
        entry["body"] = std::move(body);
        waiting.push_back(std::move(entry));
    }
    // Oldest first: the order to answer them in.
    std::reverse(waiting.begin(), waiting.end());
    return waiting;
}

json Messages::unread(const Session& session, std::string_view conversation_id, std::int64_t limit,
                      const Window* window, std::size_t* budget) {
    conversations_.require_reader(session, conversation_id);
    // What is left for the text of messages in this check-in; a caller without one gets a whole one.
    std::size_t own_budget = kCheckInBytes;
    std::size_t& left = budget != nullptr ? *budget : own_budget;
    // In full, as far as the budget goes and never more than kFullBytes; never less than an overview.
    const auto in_full = [&](json& message) {
        left -= std::min(left, shorten(message, std::max(kOverviewBytes, std::min(kFullBytes, left))));
    };
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
    json page = this->page(session, conversation_id, start, limit, 0);
    advance_cursor(session, conversation_id, page.at("next_cursor").get<std::int64_t>(), window);
    if (digested) {
        // The digest stands for many messages; it is one text of bounded size itself.
        json digest = conversations_.digest(conversation_id);
        if (digest.is_object() && digest.at("text").is_string() && digest.at("text").get<std::string>().size() > kFullBytes) {
            std::string text = digest.at("text").get<std::string>();
            std::size_t end = kFullBytes;
            while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) {
                --end;
            }
            text.resize(end);
            digest["text"] = text + " [... cut; the console shows the whole digest]";
            digest["cut"] = true;
        }
        page["digest"] = std::move(digest);
    }
    // Messages from before `start` that compacting kept in front of readers: they come along in full.
    if (start > read_upto) {
        json kept = json::array();
        // So do messages that are for this reader alone (its session, or its window by
        // name): how many others were written since never hides one of those.
        Statement rows = database_.query(
            "SELECT m.message_id FROM messages m WHERE m.conversation_id = ?1 AND m.seq > ?2 AND m.seq <= ?3 "
            "AND ((m.context = 1 AND COALESCE(m.sender_session_id, '') <> ?4 AND (m.directed = 0 OR EXISTS "
            "(SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id AND r.session_id = ?4))) "
            " OR (m.context >= 0 AND (?5 = '' OR COALESCE(m.author_window_id, '') <> ?5) AND ("
            "  (?5 <> '' AND EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id AND t.window_id = ?5)) "
            "  OR (COALESCE(m.sender_session_id, '') <> ?4 AND m.directed = 1 "
            "      AND NOT EXISTS (SELECT 1 FROM message_windows t WHERE t.message_id = m.message_id) "
            "      AND EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.message_id AND r.session_id = ?4))))) "
            "ORDER BY m.seq DESC LIMIT ?6",
            conversation_id, read_upto, start, session.session_id,
            window != nullptr ? window->window_id : std::string(), kKeptListed + 1);
        std::vector<std::string> ids;
        while (rows.step()) {
            ids.push_back(rows.text(0));
        }
        // The newest of them; how many older ones there are is said, not shown.
        const bool more_kept = static_cast<std::int64_t>(ids.size()) > kKeptListed;
        if (more_kept) {
            ids.pop_back();
        }
        const std::string fresh_since = to_rfc3339(clock_() - std::chrono::seconds(kKeptFreshSeconds));
        for (const auto& id : ids) {
            json message = message_view(id, &session);
            const bool names_reader = window != nullptr && std::ranges::any_of(message.at("to_windows"), [&](const json& target) {
                return target.at("window_id") == json(window->window_id);
            });
            // In full: what is for this reader, and what was kept for everybody not long ago.
            // An overview: what names other windows, and what was written a day or more ago
            // (the reader is told that it is there and can ask for it).
            const bool for_everybody = message.at("to_windows").empty();
            const bool fresh = message.at("created_at").get<std::string>() >= fresh_since;
            if (names_reader || (for_everybody && (fresh || message.value("directed", false)))) {
                in_full(message);
            } else {
                shorten(message, kOverviewBytes);
            }
            slim(message);
            kept.push_back(std::move(message));
        }
        std::reverse(kept.begin(), kept.end());
        if (more_kept) {
            page["kept_not_listed"] = true;
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
    // The newest first, so that the budget goes to what was written last.
    for (auto it = page.at("messages").rbegin(); it != page.at("messages").rend(); ++it) {
        json& message = *it;
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
        if (for_reader) {
            in_full(message);
        } else {
            shorten(message, kOverviewBytes);
        }
        slim(message);
        others.push_back(std::move(message));
    }
    std::reverse(others.begin(), others.end());
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
        // any of them: none is shown it again. Except what was addressed to one window
        // by name: that window still gets it, so its place stops before the first such
        // message it has not read.
        database_.execute(
            "INSERT INTO window_cursors (window_id, conversation_id, read_seq) "
            "SELECT w.window_id, ?2, MIN(?3, (SELECT next_seq - 1 FROM conversations WHERE conversation_id = ?2), "
            "  COALESCE((SELECT MIN(m.seq) - 1 FROM messages m JOIN message_windows t "
            "            ON t.message_id = m.message_id AND t.window_id = w.window_id "
            "            WHERE m.conversation_id = ?2 AND m.seq <= ?3 AND m.seq > COALESCE((SELECT x.read_seq "
            "              FROM window_cursors x WHERE x.window_id = w.window_id AND x.conversation_id = ?2), 0)), ?3)) "
            "FROM windows w WHERE w.session_id = ?1 "
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
        "a.display_name, m.forwarded_from, m.urgent, m.author_window_id, w.name, m.context, m.author_model FROM messages m "
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
                   {"display_name", nullable(row.optional_text(14))},
                   // The model that wrote it, as far as it was known then.
                   {"model", nullable(row.optional_text(20))}}}};
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
