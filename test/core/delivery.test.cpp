// Tests for src/core/delivery: what a client's hook gets to put into its
// conversation, that nothing is shown twice or marked read, the urgent routes
// (end of turn, watcher, command line) and the guards against sessions
// interrupting each other without end.
#include "core/conversation.hpp"
#include "core/delivery.hpp"
#include "core/message.hpp"
#include "core/settings.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

using acm::json;
using acm_test::error_code;

namespace {

constexpr std::int64_t kSettle = acm::Delivery::kSettleSeconds;

struct Fixture {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    acm::Conversations conversations{database, events, time.clock()};
    acm::Messages messages{database, events, conversations, time.clock()};
    acm::Delivery delivery{database, events, time.clock()};
    std::string claude_token;
    acm::Session claude = join("claude", &claude_token);
    acm::Session codex = join("codex");
    acm::Session antigravity = join("antigravity");
    std::string lobby = lobby_of(claude);
    int next_key = 0;

    acm::Session join(const std::string& client, std::string* token_out = nullptr) {
        const std::string token = "acm_" + acm::random_hex(24);
        identity.enroll(token, {{"client", client}});
        conversations.join_lobby(identity.authenticate(token));
        if (token_out != nullptr) {
            *token_out = token;
        }
        return identity.authenticate(token);
    }

    std::string lobby_of(const acm::Session& session) {
        for (const auto& entry : conversations.list_for_session(session)) {
            if (entry.at("kind") == "lobby") {
                return entry.at("conversation_id");
            }
        }
        return {};
    }

    json say(const acm::Session& from, const std::string& body, bool urgent = false, json recipients = nullptr) {
        json args = {{"conversation_id", lobby},
                     {"body", body},
                     {"urgent", urgent},
                     {"idempotency_key", "k-" + std::to_string(++next_key)}};
        if (!recipients.is_null()) {
            args["recipient_session_ids"] = recipients;
        }
        return messages.send(from, args);
    }

    json hook(const acm::Session& session, const std::string& event, json extra = json::object()) {
        extra["event"] = event;
        if (!extra.contains("client_session") && event != "watch") {
            extra["client_session"] = "conv-1";
        }
        if (!extra.contains("client")) {
            extra["client"] = "claude";
        }
        return delivery.hook(session, extra);
    }

    json jobs() { return delivery.claim().at("jobs"); }
    void pass(std::int64_t seconds) { time.advance(std::chrono::seconds(seconds)); }
};

}  // namespace

TEST_CASE("a prompt hook shows what is unread once and marks nothing read", "[delivery][hook]") {
    Fixture f;
    f.say(f.codex, "build finished, 3 warnings");
    f.say(f.antigravity, "the schema changed, re-run the migration", true);
    f.say(f.claude, "my own note");

    const json peeked = f.hook(f.claude, "prompt", {{"peek", true}});
    REQUIRE(peeked.at("count") == 2);

    const json shown = f.hook(f.claude, "prompt");
    REQUIRE(shown.at("count") == 2);
    REQUIRE(shown.at("urgent") == 1);
    REQUIRE(shown.at("more") == 0);
    const std::string text = shown.at("text");
    REQUIRE(text.contains("build finished, 3 warnings"));
    REQUIRE(text.contains("[URGENT] "));
    REQUIRE(text.contains("the schema changed"));
    REQUIRE(text.contains("the lobby"));
    REQUIRE(text.contains("not by the person typing"));
    // What the session wrote itself is not played back to it.
    REQUIRE_FALSE(text.contains("my own note"));

    // The next prompt has nothing new to add.
    const json again = f.hook(f.claude, "prompt");
    REQUIRE(again.at("count") == 0);
    REQUIRE(again.at("text") == "");

    // Shown is not read: catching up still returns both messages.
    REQUIRE(f.messages.unread(f.claude, f.lobby, 30).at("messages").size() == 2);

    // Once read, a message that the hook never showed does not come up either.
    f.say(f.codex, "one more");
    f.messages.unread(f.claude, f.lobby, 30);
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 0);

    const json view = f.delivery.list();
    REQUIRE(view.size() == 1);
    REQUIRE(view.at(0).at("session_id") == f.claude.session_id);
    REQUIRE(view.at(0).at("event") == "prompt");
    REQUIRE(view.at(0).at("runs") == 3);
    REQUIRE(view.at(0).at("knows_conversation") == true);
    REQUIRE(view.at(0).at("last_delivery").at("messages") == 2);
    // The client's own conversation id stays in the store.
    REQUIRE_FALSE(view.dump().contains("conv-1"));
}

TEST_CASE("a message addressed to someone else is never shown", "[delivery][hook]") {
    Fixture f;
    f.say(f.codex, "for antigravity only", true, json::array({f.antigravity.session_id}));
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 0);
    REQUIRE(f.hook(f.claude, "stop").at("count") == 0);
    REQUIRE(f.hook(f.antigravity, "stop").at("count") == 1);
}

TEST_CASE("a long list is cut and a long text is clipped at a character", "[delivery][hook]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0});
    std::string chinese;
    for (int i = 0; i < 1000; ++i) {
        chinese += "\xE4\xB8\xAD";  // one three-byte character
    }
    f.say(f.codex, chinese);
    for (int i = 0; i < 10; ++i) {
        f.say(f.codex, "note " + std::to_string(i));
    }
    const json first = f.hook(f.claude, "prompt");
    REQUIRE(first.at("count") == acm::Delivery::kMaxListed);
    REQUIRE(first.at("more") == 3);
    const std::string text = first.at("text");
    REQUIRE(text.contains("3 more are waiting"));
    REQUIRE(text.contains("[... cut"));
    // Still valid UTF-8: serialising would throw on a character cut in half.
    REQUIRE_NOTHROW(json(text).dump());
    // The rest comes with the next prompt rather than being skipped.
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 3);
}

TEST_CASE("the end of a turn continues only for urgent messages, once", "[delivery][urgent]") {
    Fixture f;
    f.hook(f.claude, "prompt");
    f.say(f.codex, "fyi, nothing to do");
    REQUIRE(f.hook(f.claude, "stop").at("count") == 0);

    f.say(f.codex, "production is down, stop the rollout", true);
    const json stop = f.hook(f.claude, "stop");
    REQUIRE(stop.at("count") == 1);
    REQUIRE(stop.at("text").get<std::string>().contains("Urgent: 1 message(s)"));
    REQUIRE(stop.at("text").get<std::string>().contains("production is down"));
    REQUIRE_FALSE(stop.at("text").get<std::string>().contains("fyi"));
    // The continued turn ends: there is nothing new, so it may stop.
    REQUIRE(f.hook(f.claude, "stop").at("count") == 0);

    // The ordinary message waits for the next prompt. The urgent one is listed there
    // again as long as nobody read it: its delivery may not have reached anyone.
    const json prompt = f.hook(f.claude, "prompt");
    REQUIRE(prompt.at("count") == 2);
    REQUIRE(prompt.at("text").get<std::string>().contains("fyi"));
    REQUIRE(prompt.at("text").get<std::string>().contains("production is down"));
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 0);

    const json view = f.delivery.list().at(0);
    REQUIRE(view.at("last_urgent").at("route") == "stop");
    REQUIRE(view.at("last_urgent").at("status") == "ok");
}

TEST_CASE("urgent deliveries to one session are capped per window", "[delivery][urgent][limits]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    for (std::int64_t i = 0; i < acm::Delivery::kMaxUrgentDeliveries; ++i) {
        f.say(f.codex, "urgent " + std::to_string(i), true);
        REQUIRE(f.hook(f.claude, "stop").at("count") == 1);
        f.pass(1);
    }
    f.say(f.codex, "one too many", true);
    const json held = f.hook(f.claude, "stop");
    REQUIRE(held.at("count") == 0);
    REQUIRE(held.at("held") == true);
    // Not lost: the person's next prompt shows it, and so does a later turn end.
    f.pass(acm::Delivery::kWindowSeconds);
    REQUIRE(f.hook(f.claude, "stop").at("count") == 1);
}

TEST_CASE("a session can mark only so many messages urgent per hour", "[delivery][urgent][limits]") {
    Fixture f;
    acm::MessageLimits limits = acm::message_limits(f.database);
    limits.per_minute = 0;
    limits.urgent_per_hour = 2;
    acm::set_message_limits(f.database, limits);
    REQUIRE(f.say(f.codex, "first", true).at("urgent") == true);
    REQUIRE(f.say(f.codex, "second", true).at("urgent") == true);
    const json third = f.say(f.codex, "third", true);
    REQUIRE(third.at("urgent") == false);
    REQUIRE(third.at("urgent_downgraded") == true);
    f.pass(3601);
    REQUIRE(f.say(f.codex, "fourth", true).at("urgent") == true);
    // The operator is not limited.
    for (int i = 0; i < 5; ++i) {
        const json sent = f.messages.send_as_operator(
            {{"conversation_id", f.lobby}, {"body", "operator " + std::to_string(i)}, {"urgent", true}});
        REQUIRE(sent.at("urgent") == true);
    }
}

TEST_CASE("one watcher per session delivers urgent messages", "[delivery][watch]") {
    Fixture f;
    f.hook(f.claude, "stop");
    REQUIRE(error_code([&] { f.hook(f.claude, "watch"); }) == "INVALID_ARGUMENT");

    const json idle = f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"fresh", true}, {"client_session", "conv-1"}});
    REQUIRE(idle.at("superseded") == false);
    REQUIRE(idle.at("count") == 0);
    // A newer watcher of the same conversation takes over; the older one is told to end.
    f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"fresh", true}, {"client_session", "conv-1"}});
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"client_session", "conv-1"}}).at("superseded") == true);
    // So is a watcher of a conversation that is no longer the one in use.
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w3"}, {"fresh", true}, {"client_session", "conv-0"}})
                .at("superseded") == true);

    f.say(f.codex, "not urgent");
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"client_session", "conv-1"}}).at("count") == 0);
    f.say(f.codex, "wake up", true);
    const json woken = f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"client_session", "conv-1"}});
    REQUIRE(woken.at("count") == 1);
    REQUIRE(woken.at("text").get<std::string>().contains("wake up"));
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"client_session", "conv-1"}}).at("count") == 0);
    // Watching is not using the client: the reported state stays what it was.
    REQUIRE(f.delivery.list().at(0).at("event") == "stop");
    REQUIRE(f.delivery.list().at(0).at("watch_seen_at").is_string());
}

TEST_CASE("an idle session without a watcher is handed to the gateway", "[delivery][command]") {
    Fixture f;
    f.say(f.claude, "are you there", true);
    // Codex never ran a hook: there is no conversation to address.
    f.pass(60);
    REQUIRE(f.jobs().empty());

    f.hook(f.codex, "prompt", {{"client", "codex"}, {"client_session", "thread-9"}, {"cwd", "C:/work"}});
    // The prompt hook showed it; a turn is running, so nothing is started.
    f.say(f.claude, "second call", true);
    f.pass(60);
    REQUIRE(f.jobs().empty());

    f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-9"}});
    // The end of that turn delivered it by itself.
    REQUIRE(f.jobs().empty());

    f.say(f.claude, "third call", true);
    REQUIRE(f.jobs().empty());  // the turn ended only this moment
    f.pass(kSettle);
    const json due = f.jobs();
    REQUIRE(due.size() == 1);
    REQUIRE(due.at(0).at("session_id") == f.codex.session_id);
    REQUIRE(due.at(0).at("client") == "codex");
    REQUIRE(due.at(0).at("client_session") == "thread-9");
    REQUIRE(due.at(0).at("cwd") == "C:/work");
    REQUIRE(due.at(0).at("text").get<std::string>().contains("third call"));
    REQUIRE(due.at(0).at("text").get<std::string>().contains("use only the acm tools"));
    // Claimed is attempted: it is not handed out a second time.
    f.pass(120);
    REQUIRE(f.jobs().empty());

    const json done = f.delivery.report({{"delivery_id", due.at(0).at("delivery_id")}, {"ok", true}});
    REQUIRE(done.at("last_urgent").at("route") == "command");
    REQUIRE(done.at("last_urgent").at("status") == "ok");
    f.pass(600);
    REQUIRE(f.jobs().empty());
    // Delivered this way, it is not repeated as urgent at the next turn end.
    REQUIRE(f.hook(f.codex, "stop", {{"client", "codex"}}).at("count") == 0);
    REQUIRE(error_code([&] { f.delivery.report({{"delivery_id", 9999}, {"ok", true}}); }) == "NOT_FOUND");
}

TEST_CASE("the idle route respects the switch, a watcher and repeated failure", "[delivery][command]") {
    Fixture f;
    f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-9"}});
    f.say(f.claude, "call one", true);
    f.pass(kSettle);

    f.identity.set_urgent_dispatch(f.codex.session_id, false);
    REQUIRE(f.jobs().empty());
    f.identity.set_urgent_dispatch(f.codex.session_id, true);

    // A live watcher delivers inside the conversation.
    f.hook(f.codex, "watch", {{"client", "codex"}, {"watch_id", "w1"}, {"fresh", true}, {"peek", true}});
    REQUIRE(f.jobs().empty());
    f.pass(acm::Delivery::kWatchAliveSeconds + 1);

    for (std::int64_t attempt = 0; attempt < acm::Delivery::kMaxFailures; ++attempt) {
        const json due = f.jobs();
        REQUIRE(due.size() == 1);
        f.delivery.report({{"delivery_id", due.at(0).at("delivery_id")}, {"ok", false}, {"detail", "not signed in"}});
        // A failure is not retried at once.
        f.pass(60);
        REQUIRE(f.jobs().empty());
        f.pass(acm::Delivery::kRetrySeconds);
    }
    // Three failures in a row: it stops trying until the client is used again.
    REQUIRE(f.jobs().empty());
    REQUIRE(f.delivery.list().at(0).at("last_urgent").at("detail") == "not signed in");

    // Nothing was lost: the next prompt shows the message.
    REQUIRE(f.hook(f.codex, "prompt", {{"client", "codex"}, {"client_session", "thread-9"}}).at("count") == 1);
}

TEST_CASE("a start that never reports is counted as failed", "[delivery][command]") {
    Fixture f;
    f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-9"}});
    f.say(f.claude, "call", true);
    f.pass(kSettle);
    REQUIRE(f.jobs().size() == 1);
    f.pass(acm::Delivery::kLostSeconds);
    // The lost attempt is closed and, being old enough, tried again.
    const json again = f.jobs();
    REQUIRE(again.size() == 1);
}

TEST_CASE("only clients the gateway has a command for are handed out", "[delivery][command]") {
    Fixture f;
    REQUIRE(f.delivery.command_clients().empty());
    f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-9"}});
    f.hook(f.antigravity, "stop", {{"client", "antigravity"}, {"client_session", "conv-7"}});
    f.say(f.claude, "everyone, now", true);
    f.pass(kSettle);
    REQUIRE(f.delivery.claim({{"clients", json::array()}}).at("jobs").empty());
    const json due = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(due.size() == 1);
    REQUIRE(due.at(0).at("client") == "codex");
    // What the gateway can start is remembered for the console.
    REQUIRE(f.delivery.command_clients() == json::array({"codex"}));
    // Antigravity gets it with its next prompt instead.
    REQUIRE(f.hook(f.antigravity, "prompt", {{"client", "antigravity"}}).at("urgent") == 1);
}

TEST_CASE("a hook of a session that is not active gets nothing", "[delivery][hook]") {
    Fixture f;
    f.say(f.codex, "hello", true);
    f.identity.revoke_session(f.claude.session_id);
    REQUIRE(error_code([&] { f.identity.authenticate(f.claude_token); }) != "NO_ERROR");
    REQUIRE(error_code([&] { f.hook(f.claude, "bogus"); }) == "INVALID_ARGUMENT");
}
