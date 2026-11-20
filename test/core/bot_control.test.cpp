// Tests for src/core/bot_control: the request queue through which sessions
// operate the bots another session hosts, the closed action list, the hold on
// removal wording, rate limiting and host selection.
#include "core/bot_control.hpp"
#include "core/settings.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

using acm::json;
using acm_test::error_code;

namespace {

struct Fixture {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    acm::BotControl bots{database, events, time.clock()};
    acm::Session claude = join("claude");
    acm::Session codex = join("codex");
    acm::Session grok = join("grok");

    // A session that enrolled itself, the way an installed client does.
    acm::Session join(const std::string& client, const std::string& project = "prj_default") {
        const std::string token = "acm_" + acm::random_hex(24);
        if (project != "prj_default") {
            acm_test::insert_project(database, project);
        }
        identity.enroll(token, {{"client", client}, {"project_id", project}});
        return identity.authenticate(token);
    }

    json ask(const acm::Session& from, const std::string& text, const std::string& key, json extra = json::object()) {
        json args = {{"action", "ask"}, {"text", text}, {"idempotency_key", key}};
        args.update(extra);
        return bots.request(from, args);
    }

    std::int64_t stored() {
        acm::Statement row = database.query("SELECT COUNT(*) FROM bot_requests");
        row.step();
        return row.integer(0);
    }
};

}  // namespace

TEST_CASE("a request reaches the host when it listens and its result comes back once", "[bot][flow]") {
    Fixture f;
    const json asked = f.ask(f.claude, "summarize yesterday's run", "k-1");
    REQUIRE(asked.at("status") == "queued");
    REQUIRE(asked.at("host").at("session_id") == f.grok.session_id);
    // The requester can see that nobody is listening yet.
    REQUIRE(asked.at("host").at("last_listened_at").is_null());
    REQUIRE(f.bots.news(f.grok).at("waiting_for_you") == 1);
    REQUIRE(f.bots.news(f.claude).at("results").empty());

    const json taken = f.bots.pull(f.grok, json::object());
    REQUIRE(taken.at("requests").size() == 1);
    REQUIRE(taken.at("requests").at(0).at("status") == "taken");
    REQUIRE(taken.at("requests").at(0).at("text") == "summarize yesterday's run");
    REQUIRE(taken.at("requests").at(0).at("requester").at("session_id") == f.claude.session_id);
    REQUIRE(taken.at("unfinished").empty());
    // Asking again does not hand the same request out twice, but still shows it as open.
    const json again = f.bots.pull(f.grok, json::object());
    REQUIRE(again.at("requests").empty());
    REQUIRE(again.at("unfinished").size() == 1);

    const std::string id = asked.at("request_id");
    const json answered = f.bots.respond(f.grok, {{"request_id", id}, {"result", "3 jobs ran, all green"}});
    REQUIRE(answered.at("status") == "done");
    REQUIRE(answered.at("already_answered") == false);
    REQUIRE(f.bots.respond(f.grok, {{"request_id", id}, {"result", "something else"}}).at("already_answered") == true);
    // Only the host of a request may answer it.
    REQUIRE(error_code([&] { f.bots.respond(f.codex, {{"request_id", id}, {"result", "forged"}}); }) == "NOT_FOUND");

    // The requester hears the outcome exactly once at check-in, and can list it afterwards.
    const json news = f.bots.news(f.claude);
    REQUIRE(news.at("results").size() == 1);
    REQUIRE(news.at("results").at(0).at("result") == "3 jobs ran, all green");
    REQUIRE(f.bots.news(f.claude).at("results").empty());
    REQUIRE(f.bots.list(f.claude, json::object()).at("requests").at(0).at("status") == "done");
    REQUIRE(f.bots.list(f.codex, json::object()).at("requests").empty());

    // A failure is reported as such.
    const std::string second = f.ask(f.codex, "open the dashboard", "k-2").at("request_id");
    f.bots.pull(f.grok, json::object());
    REQUIRE(f.bots.respond(f.grok, {{"request_id", second}, {"ok", false}, {"result", "no dashboard bot"}})
                .at("status") == "failed");

    // Events say that something was asked and answered, never what.
    const std::string log = f.events.read_after(0, 100).dump();
    REQUIRE(log.contains("bot_request.created"));
    REQUIRE(log.contains("bot_request.taken"));
    REQUIRE(log.contains("bot_request.finished"));
    REQUIRE_FALSE(log.contains("summarize"));
    REQUIRE_FALSE(log.contains("all green"));
}

TEST_CASE("the action list is closed and removing a bot is not on it", "[bot][actions]") {
    Fixture f;
    const auto refuse = [&](json args) {
        args["idempotency_key"] = "k-" + acm::random_hex(4);
        return error_code([&] { f.bots.request(f.claude, args); });
    };
    REQUIRE(refuse({{"action", "delete_bot"}, {"bot", "helper"}}) == "ACTION_NOT_ALLOWED");
    REQUIRE(refuse({{"action", "remove"}, {"bot", "helper"}}) == "ACTION_NOT_ALLOWED");
    REQUIRE(refuse({{"action", "archive_bot"}, {"bot", "helper"}}) == "ACTION_NOT_ALLOWED");
    REQUIRE(refuse({{"action", "reboot"}}) == "ACTION_NOT_ALLOWED");
    REQUIRE(refuse({{"action", "send_to_bot"}, {"text", "no bot named"}}) == "INVALID_ARGUMENT");
    REQUIRE(refuse({{"action", "send_to_bot"}, {"bot", "helper"}}) == "INVALID_ARGUMENT");
    REQUIRE(refuse({{"action", "get_transcript"}}) == "INVALID_ARGUMENT");
    REQUIRE(refuse({{"action", "ask"}}) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.bots.request(f.claude, {{"action", "list_bots"}}); }) == "INVALID_ARGUMENT");
    // The host cannot queue a request for itself.
    REQUIRE(error_code([&] { f.ask(f.grok, "note to self", "k-self"); }) == "INVALID_ARGUMENT");
    REQUIRE(f.stored() == 0);

    // What is on the list goes through, with the fields it needs.
    for (const json& args : {json{{"action", "list_bots"}}, json{{"action", "create_bot"}, {"bot", "reviewer"}},
                             json{{"action", "send_to_bot"}, {"bot", "reviewer"}, {"text", "check the diff"}},
                             json{{"action", "get_transcript"}, {"bot", "reviewer"}}}) {
        json complete = args;
        complete["idempotency_key"] = "ok-" + args.at("action").get<std::string>();
        REQUIRE(f.bots.request(f.claude, complete).at("status") == "queued");
    }
    REQUIRE(f.stored() == 4);
}

TEST_CASE("wording that asks for a bot to be removed waits for the operator", "[bot][hold]") {
    Fixture f;
    const json english = f.ask(f.claude, "Please DELETE the bot named helper, it is not needed", "k-en");
    REQUIRE(english.at("status") == "held");
    REQUIRE_FALSE(english.at("hold_reason").is_null());
    // The same in Chinese: "ba helper zhe-ge ji-qi-ren shan-chu".
    const json chinese = f.ask(
        f.codex, "\xe6\x8a\x8a helper \xe8\xbf\x99\xe4\xb8\xaa\xe6\x9c\xba\xe5\x99\xa8\xe4\xba\xba\xe5\x88\xa0\xe9\x99\xa4", "k-zh");
    REQUIRE(chinese.at("status") == "held");
    const json to_bot = f.bots.request(f.claude, {{"action", "send_to_bot"},
                                                  {"bot", "helper"},
                                                  {"text", "remove yourself when you are done"},
                                                  {"idempotency_key", "k-self"}});
    REQUIRE(to_bot.at("status") == "held");
    // Removing something that is not a bot is ordinary work.
    REQUIRE(f.ask(f.claude, "remove duplicate rows from the csv", "k-rows").at("status") == "queued");

    // Held requests are not handed to the host.
    const json offered = f.bots.pull(f.grok, json::object());
    REQUIRE(offered.at("requests").size() == 1);
    REQUIRE(offered.at("requests").at(0).at("text") == "remove duplicate rows from the csv");
    REQUIRE(f.bots.admin_list().at(0).at("status") == "held");

    // The operator rejects one and releases another; both decisions are final.
    const std::string rejected = english.at("request_id");
    REQUIRE(f.bots.decide(rejected, false).at("status") == "rejected");
    REQUIRE(f.bots.decide(rejected, true).at("status") == "rejected");
    const json told = f.bots.news(f.claude);
    REQUIRE(told.at("results").size() == 1);
    REQUIRE(told.at("results").at(0).at("status") == "rejected");
    const std::string released = chinese.at("request_id");
    REQUIRE(f.bots.decide(released, true).at("status") == "queued");
    REQUIRE(f.bots.pull(f.grok, json::object()).at("requests").at(0).at("request_id") == released);
    REQUIRE(error_code([&] { f.bots.decide("brq_missing", true); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.bots.respond(f.grok, {{"request_id", rejected}, {"result", "x"}}); }) == "REQUEST_CLOSED");
}

TEST_CASE("bot requests are rate limited and a repeated key is the same request", "[bot][limits]") {
    Fixture f;
    acm::set_message_limits(f.database, {3, 100, 600});
    const json first = f.ask(f.claude, "one", "k-1");
    f.ask(f.claude, "two", "k-2");
    f.ask(f.claude, "three", "k-3");
    try {
        f.ask(f.claude, "four", "k-4");
        FAIL("the fourth request within a minute must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "RATE_LIMITED");
        REQUIRE(error.details().at("limit") == 3);
        REQUIRE(error.details().at("window_seconds") == 60);
        REQUIRE(error.details().at("retry_after_seconds").get<std::int64_t>() >= 1);
        REQUIRE(error.details().at("retry_after_seconds").get<std::int64_t>() <= 60);
    }
    REQUIRE(f.stored() == 3);
    // A retry of an earlier request is not a new one, so it is not limited.
    const json replay = f.ask(f.claude, "one", "k-1");
    REQUIRE(replay.at("request_id") == first.at("request_id"));
    REQUIRE(replay.at("idempotent_replay") == true);
    // Another session has its own allowance, and the window passes.
    REQUIRE_NOTHROW(f.ask(f.codex, "from codex", "k-1"));
    f.time.advance(std::chrono::seconds(61));
    REQUIRE_NOTHROW(f.ask(f.claude, "four", "k-4"));

    // The bot host starts without limits: it answers for everyone and may ask as often as it needs.
    REQUIRE(f.grok.rate_exempt);
    REQUIRE_FALSE(f.claude.rate_exempt);
    f.bots.pull(f.codex, json::object());
    for (int index = 0; index < 10; ++index) {
        REQUIRE_NOTHROW(f.ask(f.grok, "from the host " + std::to_string(index), "g-" + std::to_string(index),
                              {{"host_session_id", f.codex.session_id}}));
    }
}

TEST_CASE("a request goes to the session that hosts bots", "[bot][host]") {
    Fixture f;
    const auto second_grok = f.join("grok");
    const auto elsewhere = f.join("grok", "prj_other");
    // Two candidates and neither has listened: the requester has to choose.
    REQUIRE(error_code([&] { f.ask(f.claude, "who are you", "k-1"); }) == "NO_BOT_HOST");
    REQUIRE(f.ask(f.claude, "who are you", "k-1", {{"host_session_id", second_grok.session_id}})
                .at("host")
                .at("session_id") == second_grok.session_id);
    REQUIRE(error_code([&] { f.ask(f.claude, "x", "k-2", {{"host_session_id", elsewhere.session_id}}); }) ==
            "INVALID_RECIPIENT");
    REQUIRE(error_code([&] { f.ask(f.claude, "x", "k-3", {{"host_session_id", "ses_missing"}}); }) ==
            "INVALID_RECIPIENT");

    // Once one of them listens, it is the host by default.
    f.bots.pull(f.grok, json::object());
    const json routed = f.ask(f.claude, "status please", "k-4");
    REQUIRE(routed.at("host").at("session_id") == f.grok.session_id);
    REQUIRE_FALSE(routed.at("host").at("last_listened_at").is_null());
    // Any session may serve as a host; it is a role taken by listening, not a vendor.
    f.bots.pull(f.codex, json::object());
    REQUIRE(error_code([&] { f.ask(f.claude, "ambiguous now", "k-5"); }) == "NO_BOT_HOST");

    // Without any host the request is refused instead of waiting forever.
    Fixture empty;
    empty.identity.revoke_session(empty.grok.session_id);
    REQUIRE(error_code([&] { empty.ask(empty.claude, "anyone", "k-1"); }) == "NO_BOT_HOST");
}
