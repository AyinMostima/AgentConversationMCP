// Tests for src/core/wake: when a wake signal is due for a session that has to
// be told from outside that work is waiting, what it carries, and that the key
// never appears in what the operator reads back.
#include "core/bot_control.hpp"
#include "core/wake.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>

using acm::json;
using acm_test::error_code;

namespace {

constexpr const char* kUrl = "https://hooks.example.test/routines/r_1";
constexpr const char* kKey = "wk_secret_value_0123456789";
constexpr std::int64_t kInterval = acm::WakeHooks::kMinIntervalSeconds;
constexpr std::int64_t kRepeat = acm::WakeHooks::kRepeatSeconds;
constexpr std::int64_t kListening = acm::WakeHooks::kListeningSeconds;

struct Fixture {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    acm::BotControl bots{database, events, time.clock()};
    acm::WakeHooks wake{database, events, time.clock()};
    acm::Session claude = join("claude");
    acm::Session grok = join("grok");
    int next_key = 0;

    acm::Session join(const std::string& client) {
        const std::string token = "acm_" + acm::random_hex(24);
        identity.enroll(token, {{"client", client}});
        return identity.authenticate(token);
    }

    void queue_work() {
        bots.request(claude, {{"action", "ask"}, {"text", "confidential instruction"}, {"idempotency_key", "k-" + std::to_string(++next_key)}});
    }

    json signals() { return wake.claim().at("signals"); }
    void pass(std::int64_t seconds) { time.advance(std::chrono::seconds(seconds)); }
    void accept(const json& due) { wake.report({{"attempt_id", due.at(0).at("attempt_id")}, {"ok", true}, {"http_status", 200}}); }
};

}  // namespace

TEST_CASE("new work is announced to a session that is not listening", "[wake][due]") {
    Fixture f;
    // No hook: nothing to send, whatever is waiting.
    f.queue_work();
    REQUIRE(f.signals().empty());

    const json hook = f.wake.set(f.grok.session_id, {{"url", kUrl}, {"key", kKey}});
    REQUIRE(hook.at("enabled") == true);
    REQUIRE(hook.at("has_key") == true);
    REQUIRE(hook.at("include_text") == false);

    const json due = f.signals();
    REQUIRE(due.size() == 1);
    REQUIRE(due.at(0).at("session_id") == f.grok.session_id);
    REQUIRE(due.at(0).at("url") == kUrl);
    REQUIRE(due.at(0).at("key") == kKey);
    // The body says that work waits and how much; it never says what.
    REQUIRE(due.at(0).at("body") == json{{"source", "acm"}, {"pending_requests", 1}, {"unread_direct_messages", 0}});
    REQUIRE_FALSE(due.dump().contains("confidential"));
    // Claiming counts as the attempt: asking again does not repeat it.
    REQUIRE(f.signals().empty());
    f.accept(due);
    REQUIRE(f.wake.list().at(0).at("last_status") == "ok");
    REQUIRE_FALSE(f.wake.list().at(0).at("last_ok_at").is_null());

    // More work a moment later is announced too, once the short merging interval has passed.
    f.pass(1);
    f.queue_work();
    REQUIRE(f.signals().empty());
    f.pass(kInterval);
    const json more = f.signals();
    REQUIRE(more.size() == 1);
    REQUIRE(more.at(0).at("body").at("pending_requests") == 2);

    // Nothing new: the same announcement is not repeated until the repeat time has passed.
    f.pass(kInterval + 1);
    REQUIRE(f.signals().empty());
    f.pass(kRepeat - kInterval - 2);
    REQUIRE(f.signals().empty());
    f.pass(2);
    REQUIRE(f.signals().size() == 1);

    // Once the session listens it sees the work itself, so no signal is sent.
    f.pass(kInterval + 1);
    f.bots.pull(f.grok, json::object());
    f.queue_work();
    f.pass(kInterval + 1);
    REQUIRE(f.signals().empty());
    // It stopped listening and that work is still queued: it is announced.
    f.pass(kListening);
    REQUIRE(f.signals().size() == 1);

    // With nothing waiting there is nothing to signal, however long it takes.
    f.bots.pull(f.grok, json::object());
    f.pass(kRepeat * 3);
    REQUIRE(f.signals().empty());
}

TEST_CASE("there is no cap on signals, and a refused one is recorded and retried later", "[wake][limits]") {
    Fixture f;
    f.wake.set(f.grok.session_id, {{"url", kUrl}, {"key", kKey}});
    // Forty pieces of work in under eight minutes, nobody listening: forty signals.
    int sent = 0;
    for (int round = 0; round < 40; ++round) {
        f.queue_work();
        f.pass(kInterval + 1);
        const json due = f.signals();
        if (!due.empty()) {
            ++sent;
            f.accept(due);
        }
    }
    REQUIRE(sent == 40);
    REQUIRE(f.wake.list().at(0).at("attempts") == 40);

    // A refusal is recorded with its reason and is not hammered: the next try waits for the repeat time.
    f.queue_work();
    f.pass(kInterval + 1);
    const json refused = f.signals();
    f.wake.report({{"attempt_id", refused.at(0).at("attempt_id")}, {"ok", false}, {"http_status", 401}, {"detail", "HTTP 401"}});
    const json hook = f.wake.list().at(0);
    REQUIRE(hook.at("last_status") == "failed");
    REQUIRE(hook.at("last_detail") == "HTTP 401");
    f.pass(kInterval + 1);
    REQUIRE(f.signals().empty());
    f.pass(kRepeat);
    const json again = f.signals();
    REQUIRE(again.size() == 1);

    // A report for an attempt that was already settled changes nothing.
    f.accept(again);
    REQUIRE(f.wake.report({{"attempt_id", again.at(0).at("attempt_id")}, {"ok", false}}).at("last_status") == "ok");
    REQUIRE(error_code([&] { f.wake.report({{"attempt_id", 99999}, {"ok", true}}); }) == "NOT_FOUND");
}

TEST_CASE("a signal the network swallowed is tried again until it gets through", "[wake][retry]") {
    Fixture f;
    f.wake.set(f.grok.session_id, {{"url", kUrl}, {"key", kKey}});
    f.queue_work();
    const std::int64_t base = acm::WakeHooks::kRetryBaseSeconds;
    const auto lose = [&](const json& due, const char* why) {
        f.wake.report({{"attempt_id", due.at(0).at("attempt_id")}, {"ok", false}, {"detail", why}});
    };
    lose(f.signals(), "UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error");
    // Soon at first, twice as long each time, never longer than the repeat time, and never giving up.
    for (const std::int64_t wait : {base, base * 2, base * 4, base * 8, base * 16, base * 32, base * 64}) {
        const std::int64_t expected = std::min(wait, kRepeat);
        f.pass(expected - 1);
        REQUIRE(f.signals().empty());
        f.pass(1);
        const json retry = f.signals();
        REQUIRE(retry.size() == 1);
        // The same signal as before: counts only, nothing new to say.
        REQUIRE(retry.at(0).at("body").at("pending_requests") == 1);
        lose(retry, "ECONNRESET: socket hang up");
    }
    // Through at last: the count starts over, so the next loss is retried soon again.
    f.pass(kRepeat);
    f.accept(f.signals());
    f.queue_work();
    f.pass(kInterval + 1);
    lose(f.signals(), "ETIMEDOUT");
    f.pass(base - 1);
    REQUIRE(f.signals().empty());
    f.pass(1);
    REQUIRE(f.signals().size() == 1);
    // Once the work is gone there is nothing to retry.
    f.bots.pull(f.grok, json::object());
    f.pass(kRepeat * 2);
    REQUIRE(f.signals().empty());
}

TEST_CASE("the operator configures, tests, disables and removes a hook without ever reading the key", "[wake][operator]") {
    Fixture f;
    // The address must be encrypted unless it is on this machine.
    REQUIRE(error_code([&] { f.wake.set(f.grok.session_id, {{"url", "http://hooks.example.test/x"}, {"key", kKey}}); }) ==
            "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.wake.set(f.grok.session_id, {{"url", "ftp://x"}, {"key", kKey}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.wake.set(f.grok.session_id, {{"url", kUrl}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.wake.set("ses_missing", {{"url", kUrl}, {"key", kKey}}); }) == "NOT_FOUND");
    REQUIRE_NOTHROW(f.wake.set(f.claude.session_id, {{"url", "http://127.0.0.1:9/hook"}, {"key", kKey}}));
    f.wake.remove(f.claude.session_id);

    f.wake.set(f.grok.session_id, {{"url", kUrl}, {"key", kKey}});
    // Nothing the operator reads back, and no event, contains the key or the address.
    REQUIRE_FALSE(f.wake.list().dump().contains(kKey));
    const std::string log = f.events.read_after(0, 100).dump();
    REQUIRE_FALSE(log.contains(kKey));
    REQUIRE_FALSE(log.contains("hooks.example.test"));

    // A test signal goes out with no work waiting, once, and does not wait for any interval.
    REQUIRE(f.signals().empty());
    f.wake.request_test(f.grok.session_id);
    const json test = f.signals();
    REQUIRE(test.size() == 1);
    REQUIRE(test.at(0).at("body").at("test") == true);
    REQUIRE(f.signals().empty());
    f.wake.request_test(f.grok.session_id);
    REQUIRE(f.signals().size() == 1);

    // Changing the address keeps the key; disabling stops signals.
    f.pass(kInterval + 1);
    const json moved = f.wake.set(f.grok.session_id, {{"url", "https://hooks.example.test/routines/r_2"}, {"enabled", false}});
    REQUIRE(moved.at("url") == "https://hooks.example.test/routines/r_2");
    f.queue_work();
    REQUIRE(f.signals().empty());
    f.wake.set(f.grok.session_id, {{"url", "https://hooks.example.test/routines/r_2"}, {"enabled", true}});
    const json resumed = f.signals();
    REQUIRE(resumed.at(0).at("key") == kKey);
    REQUIRE(resumed.at(0).at("url") == "https://hooks.example.test/routines/r_2");

    // A revoked session is never signalled; removing the hook is final and repeatable.
    f.pass(kRepeat + 1);
    f.identity.revoke_session(f.grok.session_id);
    REQUIRE(f.signals().empty());
    f.wake.remove(f.grok.session_id);
    REQUIRE_NOTHROW(f.wake.remove(f.grok.session_id));
    REQUIRE(f.wake.list().empty());
    REQUIRE(error_code([&] { f.wake.request_test(f.grok.session_id); }) == "NOT_FOUND");
}

TEST_CASE("with delivery switched on the signal carries the instructions and takes them once accepted", "[wake][delivery]") {
    Fixture f;
    const json hook = f.wake.set(f.grok.session_id, {{"url", kUrl}, {"key", kKey}, {"include_text", true}});
    REQUIRE(hook.at("include_text") == true);
    f.queue_work();
    // A moment later, so that "oldest first" is decided by time and not by the random ids.
    f.pass(1);
    f.bots.request(f.claude, {{"action", "send_to_bot"}, {"bot", "reviewer"}, {"text", "check the diff"}, {"idempotency_key", "k-bot"}});

    const json due = f.signals();
    REQUIRE(due.size() == 1);
    const json& body = due.at(0).at("body");
    REQUIRE(body.at("pending_requests") == 2);
    REQUIRE(body.at("requests").size() == 2);
    REQUIRE(body.at("requests").at(0).at("action") == "ask");
    REQUIRE(body.at("requests").at(0).at("text") == "confidential instruction");
    REQUIRE(body.at("requests").at(0).at("from") == "Claude (claude-desktop)");
    REQUIRE(body.at("requests").at(1).at("bot") == "reviewer");
    // The other side has not answered yet, so nothing counts as delivered.
    REQUIRE(f.bots.list(f.claude, json::object()).at("requests").at(0).at("status") == "queued");

    // Refused: the requests stay queued and go out again once the repeat time has passed.
    f.wake.report({{"attempt_id", due.at(0).at("attempt_id")}, {"ok", false}, {"http_status", 500}});
    REQUIRE(f.bots.list(f.claude, json::object()).at("requests").at(0).at("status") == "queued");
    f.pass(kRepeat + 1);
    const json again = f.signals();
    REQUIRE(again.at(0).at("body").at("requests").size() == 2);

    // Accepted: the bot has them. They are taken, are not signalled again, and the
    // host still sees them as unanswered when it next listens.
    f.accept(again);
    for (const auto& request : f.bots.list(f.claude, json::object()).at("requests")) {
        REQUIRE(request.at("status") == "taken");
    }
    f.pass(kRepeat + 1);
    REQUIRE(f.signals().empty());
    const json open = f.bots.pull(f.grok, json::object());
    REQUIRE(open.at("requests").empty());
    REQUIRE(open.at("unfinished").size() == 2);
    const std::string id = open.at("unfinished").at(0).at("request_id");
    REQUIRE(f.bots.respond(f.grok, {{"request_id", id}, {"result", "done"}}).at("status") == "done");

    // Switched off again, the signal goes back to counts only.
    f.wake.set(f.grok.session_id, {{"url", kUrl}, {"include_text", false}});
    f.pass(kListening + kInterval);
    f.queue_work();
    const json plain = f.signals();
    REQUIRE(plain.size() == 1);
    REQUIRE_FALSE(plain.at(0).at("body").contains("requests"));
}
