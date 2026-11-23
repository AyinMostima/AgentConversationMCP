// Tests for src/core/message: the single write path, directed visibility,
// idempotent retries, sequence paging, receipts and acknowledgement.
#include "core/message.hpp"
#include "core/settings.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

#include <memory>

using acm::json;
using acm_test::error_code;

namespace {

// Owns one open store. Reopening the same file models a service restart.
struct Core {
    acm::Database database;
    acm::EventLog events;
    acm::Identity identity;
    acm::Conversations conversations;
    acm::Messages messages;

    Core(const std::filesystem::path& file, const acm::Clock& clock)
        : database(file),
          events(database, clock),
          identity(database, events, clock),
          conversations(database, events, clock),
          messages(database, events, conversations, clock) {}
};

struct Fixture {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    std::unique_ptr<Core> core = std::make_unique<Core>(store.path(), time.clock());
    std::string claude_token;
    acm::Session claude;
    acm::Session codex_one;
    acm::Session codex_two;
    acm::Session outsider;
    std::string conversation;

    Fixture() {
        core->conversations.create_project({{"project_id", "prj_alpha"}, {"name", "Alpha"}});
        core->identity.create_agent({{"agent_id", "agt_claude"},
                                     {"provider", "anthropic"},
                                     {"client_kind", "claude-desktop"},
                                     {"display_name", "Claude"}});
        core->identity.create_agent({{"agent_id", "agt_codex"},
                                     {"provider", "openai"},
                                     {"client_kind", "codex-desktop"},
                                     {"display_name", "Codex"}});
        claude = active("agt_claude", "claude", &claude_token);
        codex_one = active("agt_codex", "codex window 1");
        codex_two = active("agt_codex", "codex window 2");
        outsider = active("agt_codex", "codex not invited");
        conversation = new_conversation("DATA-014", {member(claude), member(codex_one), member(codex_two)});
    }

    acm::Session active(const std::string& agent_id, const std::string& label, std::string* token_out = nullptr) {
        const json pairing =
            core->identity.create_pairing({{"agent_id", agent_id}, {"project_id", "prj_alpha"}, {"label", label}});
        const std::string token = pairing.at("token");
        core->identity.request_pairing(core->identity.authenticate(token), {{"client_kind", "test"}});
        core->identity.approve_pairing(pairing.at("session_id").get<std::string>());
        if (token_out != nullptr) {
            *token_out = token;
        }
        return core->identity.authenticate(token);
    }

    static json member(const acm::Session& session, bool can_read = true, bool can_write = true) {
        return {{"session_id", session.session_id}, {"can_read", can_read}, {"can_write", can_write}};
    }

    std::string new_conversation(const std::string& task_code, const json& members) {
        const std::string id = core->conversations
                                   .create_conversation(
                                       {{"project_id", "prj_alpha"}, {"task_code", task_code}, {"title", task_code}})
                                   .at("conversation_id");
        core->conversations.set_members(id, {{"expected_version", 1}, {"members", members}});
        return id;
    }

    json send(const acm::Session& from, const std::string& body, const std::string& key,
              const std::vector<std::string>& recipients = {}) {
        json args = {{"conversation_id", conversation}, {"body", body}, {"idempotency_key", key}};
        if (!recipients.empty()) {
            args["recipient_session_ids"] = recipients;
        }
        return core->messages.send(from, args);
    }

    json read(const acm::Session& as, std::int64_t after_seq = 0, std::int64_t limit = 50) {
        return core->messages.read(as, {{"conversation_id", conversation}, {"after_seq", after_seq}, {"limit", limit}});
    }

    std::int64_t message_count() {
        acm::Statement row = core->database.query("SELECT COUNT(*) FROM messages");
        row.step();
        return row.integer(0);
    }
};

std::vector<std::string> bodies(const json& page) {
    std::vector<std::string> list;
    for (const auto& message : page.at("messages")) {
        list.push_back(message.at("body").get<std::string>());
    }
    return list;
}

std::string receipt_status(const json& message, const acm::Session& session) {
    for (const auto& receipt : message.at("recipients")) {
        if (receipt.at("session_id") == session.session_id) {
            return receipt.at("status").get<std::string>();
        }
    }
    return "none";
}

}  // namespace

TEST_CASE("a shared message is stored once, read by members and acknowledged explicitly", "[message][shared]") {
    Fixture f;
    const auto before = f.core->events.watermark();
    const json sent = f.send(f.claude, "clean CSV is ready: 12 -> 8 rows", "k-shared-1");
    REQUIRE(sent.at("sequence") == 1);
    REQUIRE(sent.at("directed") == false);
    REQUIRE(sent.at("idempotent_replay") == false);
    REQUIRE(sent.at("delivery").at("action") == "shared_only");
    REQUIRE(sent.at("sender").at("session_id") == f.claude.session_id);
    REQUIRE(sent.at("sender").at("provider") == "anthropic");
    // Every reading member except the sender gets a receipt row.
    REQUIRE(sent.at("recipients").size() == 2);
    REQUIRE(receipt_status(sent, f.codex_one) == "available");
    REQUIRE(receipt_status(sent, f.claude) == "none");

    const json page = f.read(f.codex_one);
    REQUIRE(bodies(page) == std::vector<std::string>{"clean CSV is ready: 12 -> 8 rows"});
    REQUIRE(page.at("messages").at(0).at("your_receipt").at("status") == "read");
    REQUIRE_FALSE(page.at("messages").at(0).contains("recipients"));

    const std::string message_id = sent.at("message_id");
    const json ack = f.core->messages.acknowledge(f.codex_one, {{"message_id", message_id}});
    REQUIRE(ack.at("status") == "acknowledged");
    REQUIRE(ack.at("already_acknowledged") == false);
    REQUIRE_FALSE(ack.at("acknowledged_at").is_null());

    // The sender sees each recipient's own state; reading does not acknowledge.
    const json seen_by_sender = f.read(f.claude).at("messages").at(0);
    REQUIRE(receipt_status(seen_by_sender, f.codex_one) == "acknowledged");
    REQUIRE(receipt_status(seen_by_sender, f.codex_two) == "available");
    REQUIRE(seen_by_sender.at("your_receipt").is_null());

    std::vector<std::string> types;
    for (const auto& event : f.core->events.read_after(before, 100)) {
        types.push_back(event.at("event_type").get<std::string>());
    }
    REQUIRE(types == std::vector<std::string>{"message.created", "message.read", "message.acknowledged"});
}

TEST_CASE("a directed message is invisible to the sibling session of the same vendor", "[message][directed]") {
    Fixture f;
    const std::string marker = "MARK-7f3a-only-for-window-1";
    const json sent = f.send(f.claude, marker, "k-directed-1", {f.codex_one.session_id});
    const std::string message_id = sent.at("message_id");
    REQUIRE(sent.at("directed") == true);
    REQUIRE(sent.at("recipients").size() == 1);

    REQUIRE(bodies(f.read(f.codex_one)) == std::vector<std::string>{marker});

    const json hidden = f.read(f.codex_two);
    REQUIRE(hidden.at("messages").empty());
    REQUIRE(hidden.at("has_more") == false);
    // The cursor still advances past the message the caller cannot see.
    REQUIRE(hidden.at("next_cursor") == 1);
    REQUIRE(hidden.at("last_seq") == 1);
    REQUIRE(f.core->messages.inbox(f.codex_two, json::object()).at("items").empty());
    REQUIRE(error_code([&] { f.core->messages.acknowledge(f.codex_two, {{"message_id", message_id}}); }) ==
            "NOT_RECIPIENT");
    REQUIRE(error_code([&] {
                f.core->messages.send(f.codex_two, {{"conversation_id", f.conversation},
                                                    {"body", "what was that?"},
                                                    {"reply_to_message_id", message_id},
                                                    {"idempotency_key", "k-probe"}});
            }) == "NOT_FOUND");
    REQUIRE(f.message_count() == 1);

    // Committed events identify the message but never contain its body.
    REQUIRE_FALSE(f.core->events.read_after(0, 1000).dump().contains(marker));
    // The sender keeps seeing its own directed message.
    REQUIRE(bodies(f.read(f.claude)) == std::vector<std::string>{marker});
}

TEST_CASE("a retry with the same idempotency key returns the original message", "[message][idempotency]") {
    Fixture f;
    const json first = f.send(f.claude, "handoff DATA-014", "k-retry", {f.codex_one.session_id});
    const json retry = f.send(f.claude, "handoff DATA-014", "k-retry", {f.codex_one.session_id});
    REQUIRE(retry.at("message_id") == first.at("message_id"));
    REQUIRE(retry.at("sequence") == first.at("sequence"));
    REQUIRE(retry.at("idempotent_replay") == true);
    REQUIRE(retry.at("recipients") == first.at("recipients"));
    REQUIRE(f.message_count() == 1);

    try {
        f.send(f.claude, "handoff DATA-014 (edited)", "k-retry", {f.codex_one.session_id});
        FAIL("expected IDEMPOTENCY_CONFLICT");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "IDEMPOTENCY_CONFLICT");
        REQUIRE(error.details().at("message_id") == first.at("message_id"));
    }
    // Changing only the recipients is also a different request.
    REQUIRE(error_code([&] { f.send(f.claude, "handoff DATA-014", "k-retry", {f.codex_two.session_id}); }) ==
            "IDEMPOTENCY_CONFLICT");
    REQUIRE(f.message_count() == 1);
    REQUIRE(f.read(f.claude).at("last_seq") == 1);

    // Keys are scoped to the sending session, so another session may reuse the text of a key.
    const json other = f.send(f.codex_one, "ack", "k-retry");
    REQUIRE(other.at("message_id") != first.at("message_id"));
    REQUIRE(other.at("sequence") == 2);
    REQUIRE(error_code([&] {
                f.core->messages.send(f.claude, {{"conversation_id", f.conversation}, {"body", "no key"}});
            }) == "INVALID_ARGUMENT");
}

TEST_CASE("sequences are contiguous and history pages by cursor without gaps or repeats", "[message][paging]") {
    Fixture f;
    for (int index = 1; index <= 7; ++index) {
        const json sent = f.send(index % 2 == 0 ? f.claude : f.codex_one, "m" + std::to_string(index),
                                 "k-page-" + std::to_string(index));
        REQUIRE(sent.at("sequence") == index);
    }
    std::vector<std::string> collected;
    std::int64_t cursor = 0;
    int pages = 0;
    for (;;) {
        const json page = f.read(f.codex_two, cursor, 3);
        for (const auto& body : bodies(page)) {
            collected.push_back(body);
        }
        cursor = page.at("next_cursor");
        ++pages;
        if (!page.at("has_more").get<bool>()) {
            break;
        }
    }
    REQUIRE(pages == 3);
    REQUIRE(collected == std::vector<std::string>{"m1", "m2", "m3", "m4", "m5", "m6", "m7"});
    REQUIRE(cursor == 7);

    // An idle poll returns nothing and keeps the cursor; a later message is the only increment.
    const json idle = f.read(f.codex_two, cursor);
    REQUIRE(idle.at("messages").empty());
    REQUIRE(idle.at("next_cursor") == 7);
    f.send(f.claude, "m8", "k-page-8");
    REQUIRE(bodies(f.read(f.codex_two, cursor)) == std::vector<std::string>{"m8"});
}

TEST_CASE("sends and reads outside the caller's permissions are rejected without side effects",
          "[message][permissions]") {
    Fixture f;
    const auto read_only = f.active("agt_codex", "read only");
    const auto write_only = f.active("agt_codex", "write only");
    f.conversation = f.new_conversation(
        "DATA-015", {Fixture::member(f.claude), Fixture::member(read_only, true, false),
                     Fixture::member(write_only, false, true)});

    REQUIRE(error_code([&] { f.send(f.outsider, "let me in", "k1"); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.read(f.outsider); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.send(read_only, "I may not write", "k2"); }) == "WRITE_DENIED");
    REQUIRE(error_code([&] { f.read(write_only); }) == "READ_DENIED");
    REQUIRE(error_code([&] { f.send(f.claude, "to a non member", "k3", {f.outsider.session_id}); }) ==
            "INVALID_RECIPIENT");
    // A member without read permission cannot be a recipient either.
    REQUIRE(error_code([&] { f.send(f.claude, "to write only", "k4", {write_only.session_id}); }) ==
            "INVALID_RECIPIENT");
    REQUIRE(error_code([&] { f.send(f.claude, "to myself", "k5", {f.claude.session_id}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] {
                f.core->messages.send(f.claude, {{"conversation_id", f.conversation},
                                                 {"body", "forged system notice"},
                                                 {"kind", "system"},
                                                 {"idempotency_key", "k6"}});
            }) == "INVALID_ARGUMENT");
    REQUIRE(f.message_count() == 0);
    REQUIRE(f.read(f.claude).at("last_seq") == 0);

    // The write-only member can post; only the reading member receives it.
    const json posted = f.send(write_only, "status from a write-only member", "k7");
    REQUIRE(posted.at("sequence") == 1);
    REQUIRE(posted.at("recipients").size() == 2);
}

TEST_CASE("the author always comes from the credential, never from arguments", "[message][identity]") {
    Fixture f;
    const json sent = f.core->messages.send(f.codex_two, {{"conversation_id", f.conversation},
                                                          {"body", "claiming to be someone else"},
                                                          {"sender_session_id", f.claude.session_id},
                                                          {"from_agent_id", "agt_claude"},
                                                          {"idempotency_key", "k-forge"}});
    REQUIRE(sent.at("sender").at("session_id") == f.codex_two.session_id);
    REQUIRE(sent.at("sender").at("agent_id") == "agt_codex");
    // The real owner of the claimed identity is a recipient, not the author.
    REQUIRE(receipt_status(sent, f.claude) == "available");
}

TEST_CASE("losing membership or the credential cuts off earlier messages", "[message][revocation]") {
    Fixture f;
    const json sent = f.send(f.claude, "for both codex windows", "k-rev-1");
    const std::string message_id = sent.at("message_id");
    f.core->conversations.set_members(
        f.conversation, {{"expected_version", 2}, {"members", {Fixture::member(f.claude), Fixture::member(f.codex_one)}}});

    REQUIRE(error_code([&] { f.read(f.codex_two); }) == "NOT_MEMBER");
    REQUIRE(f.core->messages.inbox(f.codex_two, json::object()).at("items").empty());
    REQUIRE(error_code([&] { f.core->messages.acknowledge(f.codex_two, {{"message_id", message_id}}); }) ==
            "NOT_MEMBER");

    // A revoked credential no longer authenticates, so no command can reach the store.
    f.core->identity.revoke_session(f.claude.session_id);
    REQUIRE(error_code([&] { f.core->identity.authenticate(f.claude_token); }) == "SESSION_REVOKED");
    // History written before the revocation stays attributed and readable by remaining members.
    const json history = f.read(f.codex_one);
    REQUIRE(history.at("messages").at(0).at("sender").at("session_id") == f.claude.session_id);
}

TEST_CASE("the inbox lists unacknowledged addressed messages across conversations", "[message][inbox]") {
    Fixture f;
    const std::string first_conversation = f.conversation;
    const json a = f.send(f.claude, "first", "k-in-1");
    f.time.advance(std::chrono::seconds(1));
    f.conversation = f.new_conversation("DATA-016", {Fixture::member(f.claude), Fixture::member(f.codex_one)});
    const json b = f.send(f.claude, "second", "k-in-2", {f.codex_one.session_id});
    f.time.advance(std::chrono::seconds(1));
    f.send(f.codex_one, "my own message is not in my inbox", "k-in-3");

    const json inbox = f.core->messages.inbox(f.codex_one, json::object());
    REQUIRE(inbox.at("items").size() == 2);
    // The newest first: what was asked last is what most likely still needs an answer.
    REQUIRE(inbox.at("items").at(0).at("body") == "second");
    REQUIRE(inbox.at("items").at(1).at("body") == "first");
    REQUIRE(inbox.at("items").at(0).at("your_receipt").at("status") == "read");

    const json scoped = f.core->messages.inbox(f.codex_one, {{"conversation_id", first_conversation}});
    REQUIRE(scoped.at("items").size() == 1);

    const std::string first_id = a.at("message_id");
    f.core->messages.acknowledge(f.codex_one, {{"message_id", first_id}});
    const json again = f.core->messages.acknowledge(f.codex_one, {{"message_id", first_id}});
    REQUIRE(again.at("already_acknowledged") == true);
    const json remaining = f.core->messages.inbox(f.codex_one, json::object());
    REQUIRE(remaining.at("items").size() == 1);
    REQUIRE(remaining.at("items").at(0).at("message_id") == b.at("message_id"));

    // Exactly one acknowledgement event despite the repeated call.
    int acknowledgements = 0;
    for (const auto& event : f.core->events.read_after(0, 1000)) {
        acknowledgements += event.at("event_type") == "message.acknowledged" ? 1 : 0;
    }
    REQUIRE(acknowledgements == 1);
}

TEST_CASE("replies are threaded inside one conversation and operator messages share the write path",
          "[message][threading]") {
    Fixture f;
    const json question = f.send(f.claude, "which timezone?", "k-thr-1", {f.codex_one.session_id});
    const std::string question_id = question.at("message_id");
    const json answer = f.core->messages.send(f.codex_one, {{"conversation_id", f.conversation},
                                                            {"body", "UTC"},
                                                            {"kind", "decision"},
                                                            {"reply_to_message_id", question_id},
                                                            {"recipient_session_ids", {f.claude.session_id}},
                                                            {"idempotency_key", "k-thr-2"}});
    REQUIRE(answer.at("reply_to_message_id") == question_id);
    REQUIRE(answer.at("kind") == "decision");

    const std::string other = f.new_conversation("DATA-017", {Fixture::member(f.claude), Fixture::member(f.codex_one)});
    REQUIRE(error_code([&] {
                f.core->messages.send(f.codex_one, {{"conversation_id", other},
                                                    {"body", "cross-conversation reply"},
                                                    {"reply_to_message_id", question_id},
                                                    {"idempotency_key", "k-thr-3"}});
            }) == "NOT_FOUND");

    const json notice = f.core->messages.send_as_operator(
        {{"conversation_id", f.conversation}, {"body", "operator: pausing at 18:00"}, {"idempotency_key", "op-1"}});
    REQUIRE(notice.at("sender").at("kind") == "operator");
    REQUIRE(notice.at("sender").at("session_id").is_null());
    REQUIRE(notice.at("recipients").size() == 3);
    REQUIRE(f.core->messages.send_as_operator({{"conversation_id", f.conversation},
                                               {"body", "operator: pausing at 18:00"},
                                               {"idempotency_key", "op-1"}})
                .at("message_id") == notice.at("message_id"));

    // The operator view shows directed messages and every receipt.
    const json all = f.core->messages.read_all(f.conversation, json::object());
    REQUIRE(all.at("messages").size() == 3);
    REQUIRE(all.at("messages").at(0).at("recipients").size() == 1);
    REQUIRE(error_code([&] { f.core->messages.read_all("cnv_missing", json::object()); }) == "NOT_FOUND");
}

TEST_CASE("messages, order and receipts are identical after reopening the store", "[message][persistence]") {
    Fixture f;
    const json one = f.send(f.claude, "before restart 1", "k-per-1");
    const json two = f.send(f.codex_one, "before restart 2", "k-per-2", {f.claude.session_id});
    f.read(f.codex_one);
    f.core->messages.acknowledge(f.codex_one, {{"message_id", one.at("message_id").get<std::string>()}});
    const json before = f.core->messages.read_all(f.conversation, json::object());
    const auto watermark = f.core->events.watermark();

    f.core.reset();
    f.core = std::make_unique<Core>(f.store.path(), f.time.clock());

    const json after = f.core->messages.read_all(f.conversation, json::object());
    REQUIRE(after == before);
    REQUIRE(f.core->events.watermark() == watermark);
    // A retry that arrives after the restart still resolves to the stored message.
    const json retry = f.send(f.claude, "before restart 1", "k-per-1");
    REQUIRE(retry.at("message_id") == one.at("message_id"));
    REQUIRE(retry.at("idempotent_replay") == true);
    REQUIRE(f.send(f.claude, "after restart", "k-per-3").at("sequence") == 3);
    REQUIRE(two.at("sequence") == 2);
}

TEST_CASE("a readable message can be forwarded with its origin recorded", "[message][forward]") {
    Fixture f;
    const json original = f.send(f.claude, "C3 dropped at 12:00, please check", "k-fwd-src", {f.codex_one.session_id});
    const std::string original_id = original.at("message_id");
    const std::string other = f.new_conversation("DATA-018", {Fixture::member(f.codex_one), Fixture::member(f.codex_two)});

    // The recipient relays it into another conversation it belongs to.
    const json relayed = f.core->messages.forward(f.codex_one, {{"message_id", original_id},
                                                                {"to_conversation_id", other},
                                                                {"note", "Relaying from DATA-014."},
                                                                {"idempotency_key", "k-fwd-1"}});
    REQUIRE(relayed.at("conversation_id") == other);
    REQUIRE(relayed.at("body") == "C3 dropped at 12:00, please check");
    REQUIRE(relayed.at("forwarded_from") == original_id);
    REQUIRE(relayed.at("sender").at("session_id") == f.codex_one.session_id);
    const json& origin = relayed.at("payload").at("forwarded");
    REQUIRE(origin.at("message_id") == original_id);
    REQUIRE(origin.at("task_code") == "DATA-014");
    REQUIRE(origin.at("sender_display_name") == "Claude");
    REQUIRE(origin.at("note") == "Relaying from DATA-014.");
    // The new reader sees the relayed copy; a retry does not duplicate it.
    f.conversation = other;
    REQUIRE(bodies(f.read(f.codex_two)) == std::vector<std::string>{"C3 dropped at 12:00, please check"});
    REQUIRE(f.core->messages
                .forward(f.codex_one, {{"message_id", original_id},
                                       {"to_conversation_id", other},
                                       {"note", "Relaying from DATA-014."},
                                       {"idempotency_key", "k-fwd-1"}})
                .at("message_id") == relayed.at("message_id"));
    REQUIRE(f.message_count() == 2);

    // A session that cannot read the original cannot forward it, nor learn that it exists.
    REQUIRE(error_code([&] {
                f.core->messages.forward(f.codex_two, {{"message_id", original_id}, {"idempotency_key", "k-fwd-2"}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] {
                f.core->messages.forward(f.outsider, {{"message_id", original_id}, {"idempotency_key", "k-fwd-3"}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] {
                f.core->messages.forward(f.codex_one, {{"message_id", "msg_missing"}, {"idempotency_key", "k-fwd-4"}});
            }) == "NOT_FOUND");
    // The forwarder still needs write access to the destination.
    REQUIRE(error_code([&] {
                f.core->messages.forward(f.claude, {{"message_id", original_id},
                                                    {"to_conversation_id", other},
                                                    {"idempotency_key", "k-fwd-5"}});
            }) == "NOT_MEMBER");
    REQUIRE(f.message_count() == 2);
}

TEST_CASE("each member has its own read cursor for catching up", "[message][cursor]") {
    Fixture f;
    f.send(f.claude, "one", "k-cur-1");
    f.send(f.codex_one, "two", "k-cur-2");
    f.send(f.claude, "only for window 2", "k-cur-3", {f.codex_two.session_id});

    // Catching up returns what others wrote since last time and skips the caller's own message.
    const json first = f.core->messages.unread(f.codex_one, f.conversation, 50);
    REQUIRE(bodies(first) == std::vector<std::string>{"one"});
    REQUIRE(first.at("next_cursor") == 3);
    REQUIRE(f.core->messages.unread(f.codex_one, f.conversation, 50).at("messages").empty());
    // Another member's cursor is independent, and it sees its directed message.
    REQUIRE(bodies(f.core->messages.unread(f.codex_two, f.conversation, 50)) ==
            std::vector<std::string>{"one", "two", "only for window 2"});

    f.send(f.claude, "four", "k-cur-4");
    REQUIRE(bodies(f.core->messages.unread(f.codex_one, f.conversation, 50)) == std::vector<std::string>{"four"});
    // The cursor never moves backwards.
    f.core->messages.advance_cursor(f.codex_one, f.conversation, 1);
    REQUIRE(f.core->messages.unread(f.codex_one, f.conversation, 50).at("messages").empty());

    // Unacknowledged addressed messages are counted separately from the cursor.
    REQUIRE(f.core->messages.pending_count(f.codex_one) == 2);
    REQUIRE(f.core->messages.pending_count(f.codex_two) == 4);
    REQUIRE(f.core->messages.pending_count(f.claude) == 1);
    REQUIRE(error_code([&] { f.core->messages.unread(f.outsider, f.conversation, 50); }) == "NOT_MEMBER");
}

TEST_CASE("reading past the end never hides later messages from catching up", "[message][cursor]") {
    Fixture f;
    // An empty conversation read with a cursor far beyond anything stored.
    const json beyond = f.read(f.codex_one, 1000);
    REQUIRE(beyond.at("messages").empty());
    REQUIRE(beyond.at("last_seq") == 0);
    REQUIRE(beyond.at("next_cursor") == 0);
    // The service stores the cursor a manual read returns; neither path may overshoot.
    f.core->messages.advance_cursor(f.codex_one, f.conversation, beyond.at("next_cursor").get<std::int64_t>());
    f.core->messages.advance_cursor(f.codex_one, f.conversation, 1000);

    REQUIRE(f.send(f.claude, "first real message", "k-over-1").at("sequence") == 1);
    REQUIRE(bodies(f.core->messages.unread(f.codex_one, f.conversation, 50)) ==
            std::vector<std::string>{"first real message"});

    // The same with history present: the cursor stops at the last message.
    f.send(f.claude, "second", "k-over-2");
    const json again = f.read(f.codex_one, 1000);
    REQUIRE(again.at("messages").empty());
    REQUIRE(again.at("next_cursor") == 2);
    f.core->messages.advance_cursor(f.codex_one, f.conversation, 1000);
    f.send(f.claude, "third", "k-over-3");
    REQUIRE(bodies(f.core->messages.unread(f.codex_one, f.conversation, 50)) == std::vector<std::string>{"third"});
}

TEST_CASE("a session cannot flood a conversation", "[message][limits]") {
    Fixture f;
    acm::set_message_limits(f.core->database, {3, 5, 0});
    f.send(f.claude, "one", "k-1");
    f.send(f.claude, "two", "k-2");
    f.send(f.claude, "three", "k-3");
    try {
        f.send(f.claude, "four", "k-4");
        FAIL("the fourth message within a minute must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "RATE_LIMITED");
        REQUIRE(error.details().at("limit") == 3);
        REQUIRE(error.details().at("window_seconds") == 60);
        REQUIRE(error.details().at("retry_after_seconds").get<std::int64_t>() >= 1);
    }
    REQUIRE(f.message_count() == 3);
    // A retry of something already sent is answered from the store, not counted again.
    REQUIRE(f.send(f.claude, "one", "k-1").at("idempotent_replay") == true);
    // The limit is per session, and the operator is never limited.
    REQUIRE_NOTHROW(f.send(f.codex_one, "from another session", "k-1"));
    for (int index = 0; index < 5; ++index) {
        REQUIRE_NOTHROW(f.core->messages.send_as_operator(
            {{"conversation_id", f.conversation}, {"body", "operator " + std::to_string(index)}}));
    }

    // After the minute has passed the hourly allowance is what remains.
    f.time.advance(std::chrono::seconds(61));
    f.send(f.claude, "four", "k-4");
    f.send(f.claude, "five", "k-5");
    try {
        f.send(f.claude, "six", "k-6");
        FAIL("the sixth message within an hour must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "RATE_LIMITED");
        REQUIRE(error.details().at("window_seconds") == 3600);
    }
    // The operator can lift the limits for one session; the others keep theirs.
    f.core->identity.set_rate_exempt(f.claude.session_id, true);
    const acm::Session unlimited = f.core->identity.authenticate(f.claude_token);
    REQUIRE(unlimited.rate_exempt);
    for (int index = 6; index < 16; ++index) {
        REQUIRE_NOTHROW(f.send(unlimited, "exempt " + std::to_string(index), "k-" + std::to_string(index)));
    }
    f.send(f.codex_two, "a", "k-a");
    f.send(f.codex_two, "b", "k-b");
    f.send(f.codex_two, "c", "k-c");
    REQUIRE(error_code([&] { f.send(f.codex_two, "d", "k-d"); }) == "RATE_LIMITED");
    f.core->identity.set_rate_exempt(f.claude.session_id, false);
    REQUIRE(error_code([&] { f.send(f.core->identity.authenticate(f.claude_token), "limited again", "k-99"); }) ==
            "RATE_LIMITED");
    // Zero switches a limit off for everyone.
    acm::set_message_limits(f.core->database, {0, 0, 0});
    REQUIRE_NOTHROW(f.send(f.claude, "six", "k-6b"));
}

TEST_CASE("the same text again within the window is one message", "[message][limits]") {
    Fixture f;
    const json first = f.send(f.claude, "ping", "k-a");
    REQUIRE(first.at("duplicate_suppressed") == false);
    // A new key does not make an echo a new message.
    const json echo = f.send(f.claude, "ping", "k-b");
    REQUIRE(echo.at("message_id") == first.at("message_id"));
    REQUIRE(echo.at("duplicate_suppressed") == true);
    REQUIRE(echo.at("idempotent_replay") == false);
    REQUIRE(f.message_count() == 1);

    // Different text, different readers or a different author are different messages.
    REQUIRE(f.send(f.claude, "pong", "k-c").at("duplicate_suppressed") == false);
    REQUIRE(f.send(f.claude, "ping", "k-d", {f.codex_one.session_id}).at("duplicate_suppressed") == false);
    REQUIRE(f.send(f.codex_one, "ping", "k-a").at("duplicate_suppressed") == false);
    REQUIRE(f.message_count() == 4);

    // Once the window has passed, saying it again is a new message.
    f.time.advance(std::chrono::seconds(601));
    const json later = f.send(f.claude, "ping", "k-e");
    REQUIRE(later.at("duplicate_suppressed") == false);
    REQUIRE(later.at("message_id") != first.at("message_id"));
}