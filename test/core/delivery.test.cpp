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
        } else if (urgent) {
            // An urgent message interrupts whom it names; these tests mean the two other sessions.
            json others = json::array();
            for (const auto* session : {&claude, &codex, &antigravity}) {
                if (session->session_id != from.session_id) {
                    others.push_back(session->session_id);
                }
            }
            args["recipient_session_ids"] = others;
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
    f.hook(f.antigravity, "prompt");
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

    // The ordinary message waits for the next prompt. The urgent one is not listed a
    // second time: the turn that was continued for it had it in front of it.
    const json prompt = f.hook(f.claude, "prompt");
    REQUIRE(prompt.at("count") == 1);
    REQUIRE(prompt.at("text").get<std::string>().contains("fyi"));
    REQUIRE_FALSE(prompt.at("text").get<std::string>().contains("production is down"));
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 0);
    // Shown is not read: until the session reads it, check_in still reports both.
    REQUIRE(f.messages.unread(f.claude, f.lobby, 10).at("messages").size() == 2);

    const json view = f.delivery.list().at(0);
    REQUIRE(view.at("last_urgent").at("route") == "stop");
    REQUIRE(view.at("last_urgent").at("status") == "ok");
}

TEST_CASE("a window that was woken is not shown the same message again", "[delivery][urgent]") {
    Fixture f;
    const auto codex_hook = [&](const std::string& event) {
        return f.hook(f.codex, event, {{"client", "codex"}, {"client_session", "thread-1"}});
    };
    codex_hook("stop");
    f.pass(acm::Delivery::kSettleSeconds);
    f.say(f.claude, "an ordinary note");
    f.say(f.claude, "start the build now", true);

    // Idle: the message is handed to its client, which starts a turn with it.
    json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("start the build now"));
    // That turn's own prompt hook can run before the handing over is reported as done:
    // it adds what the window has not seen, and not the message that started the turn.
    json prompt = codex_hook("prompt");
    REQUIRE(prompt.at("count") == 1);
    REQUIRE(prompt.at("text").get<std::string>().contains("an ordinary note"));
    REQUIRE_FALSE(prompt.at("text").get<std::string>().contains("start the build now"));
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}});
    // Neither does a later prompt of that window, nor the end of its turn.
    REQUIRE(codex_hook("prompt").at("count") == 0);
    REQUIRE(codex_hook("stop").at("count") == 0);

    // A start that failed delivered nothing: the next prompt of that window does show the message.
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    f.say(f.claude, "second urgent request", true);
    jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", false}, {"detail", "exit code 3"}});
    prompt = codex_hook("prompt");
    REQUIRE(prompt.at("count") == 1);
    REQUIRE(prompt.at("text").get<std::string>().contains("second urgent request"));

    // The same for a watcher: what woke the model is not repeated with the next prompt.
    f.hook(f.claude, "stop");
    f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"client_session", "conv-1"}, {"fresh", true}});
    f.say(f.codex, "claude: look at this now", true);
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"client_session", "conv-1"}}).at("count") == 1);
    REQUIRE(f.hook(f.claude, "prompt").at("count") == 0);
}

TEST_CASE("a window is not started again while its command-line turn runs", "[delivery][urgent]") {
    Fixture f;
    const json first = f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-1"}});
    const std::string window_id = first.at("window").at("window_id");
    f.pass(acm::Delivery::kSettleSeconds);
    f.say(f.claude, "run the long job", true);
    json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}, {"detail", "started; the turn is running"}});

    // The turn it started is still running when the next urgent message arrives.
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    f.say(f.claude, "one more thing", true);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}, {"busy", {window_id}}}).at("jobs").empty());
    // Once that turn is over, the window is started for what arrived meanwhile.
    jobs = f.delivery.claim({{"clients", {"codex"}}, {"busy", json::array()}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("one more thing"));
    REQUIRE_FALSE(jobs.at(0).at("text").get<std::string>().contains("run the long job"));
}

TEST_CASE("a handing over that starts no turn is followed by another way of starting it", "[delivery][urgent]") {
    Fixture f;
    const auto codex_hook = [&](const std::string& event) {
        return f.hook(f.codex, event, {{"client", "codex"}, {"client_session", "thread-1"}});
    };
    codex_hook("stop");
    f.pass(acm::Delivery::kSettleSeconds);
    f.say(f.claude, "start the build now", true);
    json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("retry") == false);
    // The application took the message. Whether it starts a turn with it is another matter.
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}, {"expects_turn", true}});
    f.pass(acm::Delivery::kConfirmSeconds - 5);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());

    // Nothing was heard from the window: it is started once more, by a command that runs the turn itself.
    f.pass(10);
    jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("retry") == true);
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("start the build now"));
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}});
    // Once, not again and again.
    f.pass(acm::Delivery::kConfirmSeconds + acm::Delivery::kMinIntervalSeconds);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());

    // A window that does show a sign of life after the handing over is left alone.
    f.say(f.claude, "and now the tests", true);
    jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}, {"expects_turn", true}});
    f.pass(5);
    codex_hook("prompt");
    codex_hook("stop");
    f.pass(acm::Delivery::kConfirmSeconds + 10);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
}

TEST_CASE("a stand-in is started only for what is addressed to its window", "[delivery][urgent]") {
    Fixture f;
    const auto desktop = [&](const std::string& conversation, const std::string& event) {
        return f.hook(f.antigravity, event, {{"client", "antigravity"}, {"client_session", conversation}});
    };
    const std::string paper = desktop("conv-paper", "stop").at("window").at("window_id");
    f.pass(1);
    const std::string figures = desktop("conv-figures", "stop").at("window").at("window_id");
    f.pass(acm::Delivery::kSettleSeconds);
    const json rules = {{"clients", {"antigravity"}}};

    // To everybody, meant for somebody else: no stand-in goes to work in every Antigravity window.
    f.say(f.claude, "all Codex windows: continue working", true, json::array());
    REQUIRE(f.delivery.claim(rules).at("jobs").empty());
    // Naming a window starts that one, and only with what names it.
    json args = {{"conversation_id", f.lobby}, {"body", "paper: rebuild the tables"}, {"urgent", true}, {"idempotency_key", "to-paper"}};
    f.messages.send(f.claude, args, nullptr, {acm::Window{paper, f.antigravity.session_id, "paper"}});
    json jobs = f.delivery.claim(rules).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("window_id") == paper);
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("rebuild the tables"));
    REQUIRE_FALSE(jobs.at(0).at("text").get<std::string>().contains("all Codex windows"));
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}, {"stand_in", true}});

    // A message for the application alone, naming no window, goes to the window it used last.
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    f.say(f.claude, "antigravity: are the figures done", true, json::array({f.antigravity.session_id}));
    jobs = f.delivery.claim(rules).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("window_id") == figures);
    // While that stand-in works, no other one is started for the same application ...
    json busy = rules;
    busy["busy_clients"] = {"antigravity"};
    args["body"] = "paper: one more table";
    args["idempotency_key"] = "to-paper-2";
    f.messages.send(f.claude, args, nullptr, {acm::Window{paper, f.antigravity.session_id, "paper"}});
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    REQUIRE(f.delivery.claim(busy).at("jobs").empty());
    // ... and one that was put off comes up again without counting as a failure.
    jobs = f.delivery.claim(rules).at("jobs");
    REQUIRE(jobs.size() == 1);
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", false}, {"postponed", true}});
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    REQUIRE(f.delivery.claim(rules).at("jobs").size() == 1);
}

TEST_CASE("a stand-in acts for a window that cannot be started itself", "[delivery][urgent]") {
    Fixture f;
    const auto desktop = [&](const std::string& event) {
        return f.hook(f.antigravity, event, {{"client", "antigravity"}, {"client_session", "desktop-conv"}});
    };
    desktop("stop");
    f.pass(acm::Delivery::kSettleSeconds);
    f.say(f.claude, "antigravity: build the figures", true);
    const json jobs = f.delivery.claim({{"clients", {"antigravity"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}, {"stand_in", true}});

    // The window is not woken for it again ...
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    REQUIRE(f.delivery.claim({{"clients", {"antigravity"}}}).at("jobs").empty());

    // ... unless the stand-in's turn fails after it had been reported as under way: that is a
    // failure like any other, shown as one and tried again after the usual pause.
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", false}, {"late", true}, {"detail", "agy (stand-in): exit code 1"}});
    REQUIRE(f.delivery.list().at(0).at("last_urgent").at("status") == "failed");
    REQUIRE(f.delivery.claim({{"clients", {"antigravity"}}}).at("jobs").empty());
    f.pass(acm::Delivery::kRetrySeconds + 1);
    const json again = f.delivery.claim({{"clients", {"antigravity"}}}).at("jobs");
    REQUIRE(again.size() == 1);
    REQUIRE(again.at(0).at("text").get<std::string>().contains("build the figures"));
    f.delivery.report({{"delivery_id", again.at(0).at("delivery_id")}, {"ok", true}, {"stand_in", true}});
    REQUIRE(desktop("stop").at("count") == 0);
    // The window's own conversation has not seen the message: its next prompt lists it.
    const json prompt = desktop("prompt");
    REQUIRE(prompt.at("count") == 1);
    REQUIRE(prompt.at("text").get<std::string>().contains("build the figures"));
}

TEST_CASE("an urgent message reaches a conversation in the middle of its turn", "[delivery][urgent]") {
    Fixture f;
    const auto codex_hook = [&](const std::string& event) {
        return f.hook(f.codex, event, {{"client", "codex"}, {"client_session", "thread-1"}});
    };
    codex_hook("prompt");
    f.say(f.claude, "an ordinary note");
    // Nothing urgent: a tool call adds nothing, however many there are.
    REQUIRE(codex_hook("tool").at("count") == 0);
    f.say(f.claude, "stop: the input file is wrong", true);
    // The next tool call of the running turn carries it to the model.
    const json mid = codex_hook("tool");
    REQUIRE(mid.at("count") == 1);
    REQUIRE(mid.at("text").get<std::string>().contains("Urgent: 1 message(s)"));
    REQUIRE(mid.at("text").get<std::string>().contains("the input file is wrong"));
    REQUIRE_FALSE(mid.at("text").get<std::string>().contains("an ordinary note"));
    // Once: not with the tool calls after it, not at the end of the turn, not with the next prompt.
    REQUIRE(codex_hook("tool").at("count") == 0);
    REQUIRE(codex_hook("stop").at("count") == 0);
    const json next = codex_hook("prompt");
    REQUIRE(next.at("count") == 1);
    REQUIRE(next.at("text").get<std::string>().contains("an ordinary note"));
    // A conversation that calls tools is in a turn: it is not started from outside meanwhile.
    codex_hook("tool");
    f.pass(acm::Delivery::kSettleSeconds + 1);
    f.say(f.claude, "one more urgent thing", true);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    const json view = f.delivery.list().at(0);
    REQUIRE(view.at("event") == "prompt");
    REQUIRE(view.at("last_urgent").at("route") == "tool");
}

TEST_CASE("urgent deliveries to one session are capped per window", "[delivery][urgent][limits]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    // The window has to be known first: nothing urgent from before it existed interrupts it.
    f.hook(f.claude, "prompt");
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

TEST_CASE("one watcher per window delivers urgent messages", "[delivery][watch]") {
    Fixture f;
    f.hook(f.claude, "stop");
    REQUIRE(error_code([&] { f.hook(f.claude, "watch"); }) == "INVALID_ARGUMENT");

    const json idle = f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"fresh", true}, {"client_session", "conv-1"}});
    REQUIRE(idle.at("superseded") == false);
    REQUIRE(idle.at("count") == 0);
    // A newer watcher of the same conversation takes over; the older one is told to end.
    f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"fresh", true}, {"client_session", "conv-1"}});
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w1"}, {"client_session", "conv-1"}}).at("superseded") == true);
    // A watcher of another conversation is that window's own; neither displaces the other.
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w3"}, {"fresh", true}, {"client_session", "conv-0"}})
                .at("superseded") == false);
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"client_session", "conv-1"}}).at("superseded") == false);

    // conv-1 is the conversation Claude used last: what is urgent for Claude as such wakes that one.
    f.pass(1);
    f.hook(f.claude, "stop");
    f.say(f.codex, "not urgent");
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w2"}, {"client_session", "conv-1"}}).at("count") == 0);
    f.say(f.codex, "wake up", true);
    REQUIRE(f.hook(f.claude, "watch", {{"watch_id", "w3"}, {"client_session", "conv-0"}}).at("count") == 0);
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
    REQUIRE(due.at(0).at("text").get<std::string>().contains("started by ACM while the conversation was idle"));
    // Claimed is attempted: it is not handed out a second time.
    f.pass(120);
    REQUIRE(f.jobs().empty());

    const json done = f.delivery.report({{"delivery_id", due.at(0).at("delivery_id")}, {"ok", true}});
    REQUIRE(done.at("last_urgent").at("route") == "command");
    REQUIRE(done.at("last_urgent").at("status") == "ok");
    f.pass(600);
    REQUIRE(f.jobs().empty());
    // Delivered this way, it is not repeated as urgent at the next turn end.
    REQUIRE(f.hook(f.codex, "stop", {{"client", "codex"}, {"client_session", "thread-9"}}).at("count") == 0);
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
    f.hook(f.codex, "watch", {{"client", "codex"}, {"client_session", "thread-9"}, {"watch_id", "w1"}, {"fresh", true}, {"peek", true}});
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
