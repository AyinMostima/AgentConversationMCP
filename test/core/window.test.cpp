// Tests for src/core/window: the single conversations of an application are
// told apart, named and addressed; a message reaches the windows it is meant
// for and wakes exactly those; two windows of one application hear each other
// and each keeps its own place in what it has read.
#include "core/conversation.hpp"
#include "core/delivery.hpp"
#include "core/message.hpp"
#include "core/settings.hpp"
#include "core/window.hpp"
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
    acm::Conversations conversations{database, events, time.clock()};
    acm::Messages messages{database, events, conversations, time.clock()};
    acm::Delivery delivery{database, events, time.clock()};
    acm::Windows windows{database, events, time.clock()};
    acm::Session claude = join("claude");
    acm::Session codex = join("codex");
    std::string lobby = lobby_of(claude);
    int next_key = 0;

    acm::Session join(const std::string& client) {
        const std::string token = "acm_" + acm::random_hex(24);
        identity.enroll(token, {{"client", client}});
        conversations.join_lobby(identity.authenticate(token));
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
    // The window of one conversation of an application, as its bridge would name it.
    acm::Window open(const acm::Session& session, const std::string& client, const std::string& conversation) {
        return *windows.resolve(session, client, conversation, std::nullopt);
    }
    // An urgent message for one session as such, naming none of its windows.
    json tell(const acm::Session& from, const acm::Session& to, const std::string& body, const acm::Window* window = nullptr) {
        return messages.send(from,
                             {{"conversation_id", lobby},
                              {"body", body},
                              {"urgent", true},
                              {"recipient_session_ids", json::array({to.session_id})},
                              {"idempotency_key", "k-" + std::to_string(++next_key)}},
                             window);
    }
    json say(const acm::Session& from, const acm::Window* window, const std::string& body, bool urgent = false,
             std::vector<acm::Window> to = {}) {
        return messages.send(from,
                             {{"conversation_id", lobby},
                              {"body", body},
                              {"urgent", urgent},
                              {"idempotency_key", "k-" + std::to_string(++next_key)}},
                             window, std::move(to));
    }
    json hook(const acm::Session& session, const std::string& client, const std::string& conversation,
              const std::string& event, json extra = json::object()) {
        extra["event"] = event;
        extra["client"] = client;
        extra["client_session"] = conversation;
        return delivery.hook(session, extra);
    }
    void pass(std::int64_t seconds) { time.advance(std::chrono::seconds(seconds)); }
};

}  // namespace

TEST_CASE("each conversation of an application is a window with a name", "[window][identity]") {
    Fixture f;
    const acm::Window first = f.open(f.codex, "codex", "thread-a");
    const acm::Window second = f.open(f.codex, "codex", "thread-b");
    REQUIRE(first.window_id != second.window_id);
    REQUIRE(first.name.starts_with("codex-"));
    // The same conversation is the same window, whoever reports it: bridge or hook.
    REQUIRE(f.open(f.codex, "codex", "thread-a").window_id == first.window_id);
    REQUIRE(f.hook(f.codex, "codex", "thread-a", "prompt").at("window").at("window_id") == first.window_id);
    // The same id under another application is another window.
    REQUIRE(f.open(f.claude, "claude", "thread-a").window_id != first.window_id);

    // A window names itself; the name is how others address it.
    const json named = f.windows.rename(f.codex, first, {{"name", "hy"}});
    REQUIRE(named.at("name") == "hy");
    REQUIRE(f.windows.lookup(f.codex.project_id, {"HY"}).at(0).window_id == first.window_id);
    REQUIRE(f.windows.lookup(f.codex.project_id, {first.window_id, "hy"}).size() == 1);
    REQUIRE(error_code([&] { f.windows.rename(f.codex, second, {{"name", "Hy"}}); }) == "NAME_TAKEN");
    REQUIRE_NOTHROW(f.windows.rename(f.codex, first, {{"name", "hy"}}));
    for (const char* bad : {"", "two words", "a,b", "win_x", "q\"q"}) {
        REQUIRE(error_code([&] { f.windows.rename(f.codex, second, {{"name", bad}}); }) == "INVALID_ARGUMENT");
    }
    // Nobody renames a window of another session; the operator renames any.
    REQUIRE(error_code([&] { f.windows.rename(f.claude, second, {{"name", "mine"}}); }) == "NOT_FOUND");
    REQUIRE(f.windows.admin_rename(second.window_id, {{"name", "nbs"}}).at("name") == "nbs");

    try {
        f.windows.lookup(f.codex.project_id, {"nobody"});
        FAIL("an unknown window must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "UNKNOWN_WINDOW");
        // The refusal says which windows exist, so the sender can correct itself.
        REQUIRE(error.details().at("windows").dump().contains("hy"));
        REQUIRE(error.details().at("windows").dump().contains("nbs"));
    }

    const json listed = f.windows.of_session(f.codex.session_id, &first);
    REQUIRE(listed.size() == 2);
    REQUIRE(std::ranges::count_if(listed, [](const json& entry) { return entry.at("is_you") == true; }) == 1);
    // A window nobody used for a day is not offered any more, and comes back by being used.
    f.pass(acm::Windows::kLiveSeconds + 1);
    REQUIRE(f.windows.of_session(f.codex.session_id, nullptr).empty());
    REQUIRE(error_code([&] { f.windows.lookup(f.codex.project_id, {"hy"}); }) == "UNKNOWN_WINDOW");
    f.hook(f.codex, "codex", "thread-a", "prompt");
    REQUIRE(f.windows.lookup(f.codex.project_id, {"hy"}).size() == 1);
}

TEST_CASE("a client that does not say which conversation is calling", "[window][identity]") {
    Fixture f;
    // Nothing is known: no window is assumed.
    REQUIRE_FALSE(f.windows.resolve(f.codex, "antigravity", std::nullopt, std::nullopt).has_value());
    // Exactly one of its conversations is in a turn: the call comes from that one.
    const std::string only = f.hook(f.codex, "antigravity", "conv-1", "prompt").at("window").at("window_id");
    REQUIRE(f.windows.resolve(f.codex, "antigravity", std::nullopt, std::nullopt)->window_id == only);
    // Two are in a turn: it cannot be told, so nothing is assumed.
    f.hook(f.codex, "antigravity", "conv-2", "prompt");
    REQUIRE_FALSE(f.windows.resolve(f.codex, "antigravity", std::nullopt, std::nullopt).has_value());
    f.hook(f.codex, "antigravity", "conv-2", "stop");
    REQUIRE(f.windows.resolve(f.codex, "antigravity", std::nullopt, std::nullopt)->window_id == only);
}

TEST_CASE("a message reaches the windows it is meant for", "[window][delivery]") {
    Fixture f;
    const acm::Window hy = f.open(f.codex, "codex", "thread-hy");
    const acm::Window nbs = f.open(f.codex, "codex", "thread-nbs");
    const acm::Window lead = f.open(f.claude, "claude", "conv-lead");
    f.windows.rename(f.codex, hy, {{"name", "hy"}});
    f.windows.rename(f.codex, nbs, {{"name", "nbs"}});

    // Without targets it is for every window of its readers, each once.
    f.say(f.claude, &lead, "status round, everyone");
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt").at("count") == 1);
    REQUIRE(f.hook(f.codex, "codex", "thread-nbs", "prompt").at("count") == 1);
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt").at("count") == 0);

    // With a target only that window is shown it; the others are left in peace.
    const json sent = f.say(f.claude, &lead, "hy: start the G4 run", false, f.windows.lookup(f.codex.project_id, {"hy"}));
    REQUIRE(sent.at("to_windows") == json::array({{{"window_id", hy.window_id}, {"name", "hy"}}}));
    REQUIRE(sent.at("from_window").at("window_id") == lead.window_id);
    const json shown = f.hook(f.codex, "codex", "thread-hy", "prompt");
    REQUIRE(shown.at("count") == 1);
    REQUIRE(shown.at("text").get<std::string>().contains("addressed to this window"));
    REQUIRE(shown.at("text").get<std::string>().contains("This conversation is window \"hy\""));
    REQUIRE(shown.at("text").get<std::string>().contains("Claude window \"" + lead.name + "\""));
    REQUIRE(f.hook(f.codex, "codex", "thread-nbs", "prompt").at("count") == 0);
    // The author's own window is never shown what it wrote.
    REQUIRE(f.hook(f.claude, "claude", "conv-lead", "prompt").at("count") == 0);

    // A window of a session that cannot read the message cannot be a target.
    const std::string topic =
        f.conversations.create_conversation({{"project_id", "prj_default"}, {"task_code", "T-1"}, {"title", "t"}})
            .at("conversation_id");
    f.conversations.set_members(topic, {{"expected_version", 1},
                                        {"members", {{{"session_id", f.claude.session_id}, {"can_read", true}, {"can_write", true}}}}});
    REQUIRE(error_code([&] {
                f.messages.send(f.claude, {{"conversation_id", topic}, {"body", "x"}, {"idempotency_key", "t-1"}}, &lead,
                                f.windows.lookup(f.codex.project_id, {"hy"}));
            }) == "INVALID_RECIPIENT");
    // The same text to another window is another request, not a repeat.
    f.say(f.claude, &lead, "ping", false, f.windows.lookup(f.codex.project_id, {"hy"}));
    f.say(f.claude, &lead, "ping", false, f.windows.lookup(f.codex.project_id, {"nbs"}));
    REQUIRE(f.hook(f.codex, "codex", "thread-nbs", "prompt").at("count") == 1);
}

TEST_CASE("two windows of one application hear each other and read on their own", "[window][cursor]") {
    Fixture f;
    const acm::Window hy = f.open(f.codex, "codex", "thread-hy");
    const acm::Window nbs = f.open(f.codex, "codex", "thread-nbs");
    f.say(f.claude, nullptr, "from the lead");
    f.say(f.codex, &hy, "[hy] my part is done");

    // nbs sees the lead's message and what its sibling wrote; hy does not see its own.
    const json for_nbs = f.messages.unread(f.codex, f.lobby, 30, &nbs).at("messages");
    REQUIRE(for_nbs.size() == 2);
    REQUIRE(for_nbs.at(1).at("from_window").at("window_id") == hy.window_id);
    const json for_hy = f.messages.unread(f.codex, f.lobby, 30, &hy).at("messages");
    REQUIRE(for_hy.size() == 1);
    REQUIRE(for_hy.at(0).at("body") == "from the lead");
    // Each has caught up for itself: one reading did not take the news from the other.
    REQUIRE(f.messages.unread(f.codex, f.lobby, 30, &nbs).at("messages").empty());
    REQUIRE(f.messages.unread(f.codex, f.lobby, 30, &hy).at("messages").empty());

    // The hooks follow the same rule.
    f.say(f.codex, &nbs, "[nbs] taking over");
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt").at("count") == 1);
    REQUIRE(f.hook(f.codex, "codex", "thread-nbs", "prompt").at("count") == 0);

    // A caller whose window is not known cannot be told apart from its siblings, so
    // it is shown nothing its own session wrote.
    f.say(f.codex, nullptr, "from an unknown window");
    const json rest = f.messages.unread(f.codex, f.lobby, 30, &hy).at("messages");
    REQUIRE(rest.size() == 1);
    REQUIRE(rest.at(0).at("body") == "[nbs] taking over");
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt").at("count") == 0);
    // A new window starts where the session as a whole is, not at the beginning of time.
    const acm::Window late = f.open(f.codex, "codex", "thread-late");
    REQUIRE(f.messages.unread(f.codex, f.lobby, 30, &late).at("messages").empty());
}

TEST_CASE("an urgent message wakes exactly the windows it is meant for", "[window][urgent]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    const acm::Window lead = f.open(f.claude, "claude", "conv-lead");
    // Three idle conversations: two of Codex, known from their hooks, and a second one of Claude with a watcher.
    f.hook(f.codex, "codex", "thread-hy", "stop");
    f.hook(f.codex, "codex", "thread-nbs", "stop");
    f.hook(f.claude, "claude", "conv-other", "stop");
    f.hook(f.claude, "claude", "conv-other", "watch", {{"watch_id", "w-other"}, {"fresh", true}});
    f.hook(f.claude, "claude", "conv-lead", "watch", {{"watch_id", "w-lead"}, {"fresh", true}});
    const acm::Window hy = f.open(f.codex, "codex", "thread-hy");
    const acm::Window nbs = f.open(f.codex, "codex", "thread-nbs");
    f.windows.rename(f.codex, hy, {{"name", "hy"}});
    f.pass(acm::Delivery::kSettleSeconds);

    // Addressed to one window: only that one is handed to its client.
    f.say(f.claude, &lead, "hy: resume now", true, f.windows.lookup(f.codex.project_id, {"hy"}));
    json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-hy");
    REQUIRE(jobs.at(0).at("window") == "hy");
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("hy: resume now"));
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}});
    // The watcher of Claude's other conversation is not woken by it either: it was not meant for it.
    REQUIRE(f.hook(f.claude, "claude", "conv-other", "watch", {{"watch_id", "w-other"}}).at("count") == 0);

    // Addressed to nobody in particular: nobody is interrupted. It waits for each window's next prompt.
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    const json loose = f.say(f.claude, &lead, "everyone: report status", true);
    REQUIRE(loose.at("urgent_note").get<std::string>().contains("interrupts nobody"));
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    REQUIRE(f.hook(f.claude, "claude", "conv-other", "watch", {{"watch_id", "w-other"}}).at("count") == 0);
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt", {{"peek", true}}).at("text").get<std::string>().contains("everyone: report status"));

    // Naming several windows wakes each of them, each through its own route.
    const acm::Window other = f.open(f.claude, "claude", "conv-other");
    const json named = f.say(f.claude, &lead, "hy, nbs and the other Claude: report status", true, {hy, nbs, other});
    REQUIRE_FALSE(named.contains("urgent_note"));
    jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 2);
    REQUIRE(jobs.at(0).at("client_session") != jobs.at(1).at("client_session"));
    const json woken = f.hook(f.claude, "claude", "conv-other", "watch", {{"watch_id", "w-other"}});
    REQUIRE(woken.at("count") == 1);
    // Not the conversation that wrote it.
    REQUIRE(f.hook(f.claude, "claude", "conv-lead", "watch", {{"watch_id", "w-lead"}}).at("count") == 0);
    // Watchers of different conversations do not displace each other.
    REQUIRE(f.hook(f.claude, "claude", "conv-lead", "watch", {{"watch_id", "w-lead"}}).at("superseded") == false);
    REQUIRE(f.hook(f.claude, "claude", "conv-other", "watch", {{"watch_id", "w-other"}}).at("superseded") == false);

    // A conversation the vendor does not know is given up for good; the other goes on.
    for (const auto& job : jobs) {
        const bool gone = job.at("client_session") == "thread-nbs";
        f.delivery.report({{"delivery_id", job.at("delivery_id")},
                           {"ok", !gone},
                           {"detail", gone ? "exit code 1: failed to read thread: no rollout found for thread id thread-nbs" : "queued"}});
    }
    REQUIRE(f.windows.view(nbs.window_id).at("addressable") == false);
    // Nothing was broken by it: the route does not show a failure, the last delivery is the one that worked.
    json state;
    for (const auto& entry : f.delivery.list()) {
        if (entry.at("session_id") == f.codex.session_id) {
            state = entry;
        }
    }
    REQUIRE(state.at("last_urgent").at("status") == "ok");
    REQUIRE(state.at("last_urgent").at("window") == "hy");
    f.pass(acm::Delivery::kRetrySeconds + 1);
    f.say(f.claude, &lead, "second round", true, {hy, nbs});
    jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-hy");
    // And it is no longer offered as a window to address.
    REQUIRE(error_code([&] { f.windows.lookup(f.codex.project_id, {nbs.window_id}); }) == "UNKNOWN_WINDOW");
}

TEST_CASE("a conversation its client does not keep is not a window to address or wake", "[window][urgent]") {
    Fixture f;
    // Codex runs its hooks for helper threads too (naming a conversation, for one); it keeps no record of them.
    f.hook(f.codex, "codex", "thread-real", "start", {{"persistent", true}});
    f.hook(f.codex, "codex", "thread-helper", "start", {{"persistent", false}});
    f.pass(acm::Delivery::kSettleSeconds);
    json names = json::array();
    for (const auto& entry : f.windows.of_session(f.codex.session_id, nullptr)) {
        names.push_back(entry.at("name"));
    }
    REQUIRE(names.size() == 1);
    f.tell(f.claude, f.codex, "codex: start the build");
    const json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-real");
    // Once its client does keep it, it counts.
    f.hook(f.codex, "codex", "thread-helper", "stop", {{"persistent", true}});
    REQUIRE(f.windows.of_session(f.codex.session_id, nullptr).size() == 2);
}

TEST_CASE("conversations on a client's record are windows that can be woken by name", "[window][urgent]") {
    Fixture f;
    const std::string an_hour_ago = acm::to_rfc3339(f.time.clock()() - std::chrono::hours(1));
    const std::string two_days_ago = acm::to_rfc3339(f.time.clock()() - std::chrono::hours(48));
    const json listed = {{"client", "codex"},
                         {"windows",
                          {{{"client_session", "thread-api"}, {"name", "API Refactor, part 2"}, {"cwd", "C:\\projects\\app"}, {"seen_at", an_hour_ago}},
                           {{"client_session", "thread-web"}, {"name", "API Refactor, part 2"}, {"seen_at", an_hour_ago}},
                           {{"client_session", "thread-untitled"}, {"seen_at", an_hour_ago}},
                           {{"client_session", "thread-old"}, {"name", "long ago"}, {"seen_at", two_days_ago}}}}};
    json outcome = f.windows.import(listed);
    REQUIRE(outcome.at("session_id") == f.codex.session_id);
    REQUIRE(outcome.at("added") == 3);
    // Again changes nothing; a client nobody registered has no windows to take over.
    outcome = f.windows.import(listed);
    REQUIRE(outcome.at("added") == 0);
    REQUIRE(outcome.at("known") == 3);
    REQUIRE(f.windows.import({{"client", "nobody"}, {"windows", json::array()}}).at("session_id").is_null());

    // Each has a name one can type: the title without blanks and commas, made distinct, or a generated one.
    json names = json::array();
    for (const auto& entry : f.windows.of_session(f.codex.session_id, nullptr)) {
        REQUIRE(entry.at("imported") == true);
        REQUIRE(entry.at("state") == "idle");
        names.push_back(entry.at("name"));
    }
    REQUIRE(names.size() == 3);
    REQUIRE(std::ranges::count(names, json("API-Refactor-part-2")) == 1);
    const acm::Window api = f.windows.lookup(f.codex.project_id, {"API-Refactor-part-2"}).front();

    // A message to everybody does not start every conversation Codex has on record ...
    f.pass(acm::Delivery::kSettleSeconds);
    f.say(f.claude, nullptr, "everyone: status please", true);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    // ... one that names a window starts that one.
    f.say(f.claude, nullptr, "resume the api build", true, {api});
    const json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("window") == "API-Refactor-part-2");
    REQUIRE(jobs.at(0).at("text").get<std::string>().contains("resume the api build"));
    REQUIRE_FALSE(jobs.at(0).at("text").get<std::string>().contains("status please"));

    // What its client calls a conversation goes with the window, also with one that named itself:
    // that is what lets another session pick the right window without asking anybody.
    const acm::Window self_named = f.open(f.codex, "codex", "thread-self");
    f.windows.rename(f.codex, self_named, {{"name", "docs"}});
    f.windows.import({{"client", "codex"},
                      {"windows", {{{"client_session", "thread-self"}, {"title", "Update the release guide"}, {"seen_at", an_hour_ago}}}}});
    json docs;
    for (const auto& entry : f.windows.of_session(f.codex.session_id, nullptr)) {
        if (entry.at("name") == "docs") {
            docs = entry;
        }
    }
    REQUIRE(docs.at("title") == "Update the release guide");
    REQUIRE(docs.at("imported") == false);
    try {
        f.windows.lookup(f.codex.project_id, {"release-guide"});
        FAIL("an unknown name must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "UNKNOWN_WINDOW");
        const json choices = error.details().at("choices");
        REQUIRE(std::ranges::any_of(choices, [](const json& entry) {
            return entry.at("name") == "docs" && entry.at("title") == "Update the release guide" && entry.at("client") == "codex";
        }));
    }
    f.windows.import({{"client", "codex"}, {"windows", json::array()}, {"not_windows", {"thread-self"}}});

    // A sub-agent of Codex that called a tool looked like a window; its client's record says it is none.
    f.open(f.codex, "codex", "thread-subagent");
    REQUIRE(f.windows.of_session(f.codex.session_id, nullptr).size() == 4);
    REQUIRE(f.windows.import({{"client", "codex"}, {"windows", json::array()}, {"not_windows", {"thread-subagent", "never-seen"}}}).at("retired") == 1);
    REQUIRE(f.windows.of_session(f.codex.session_id, nullptr).size() == 3);

    // Once the conversation is heard of by itself it is a window like any other.
    f.hook(f.codex, "codex", "thread-api", "prompt");
    for (const auto& entry : f.windows.of_session(f.codex.session_id, nullptr)) {
        REQUIRE(entry.at("imported") == (entry.at("name") != "API-Refactor-part-2"));
    }
}

TEST_CASE("a window whose turn was cut off can be woken again, unless its client is out of quota", "[window][urgent]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    const acm::Window lead = f.open(f.claude, "claude", "conv-lead");
    // A turn starts and never reports its end (the vendor stopped it: usage limit, the app closed).
    f.hook(f.codex, "codex", "thread-cut", "prompt");
    const acm::Window cut = f.open(f.codex, "codex", "thread-cut");
    f.pass(60);
    f.say(f.claude, &lead, "cut: pick it up again", true, {cut});
    // In a turn a short while ago: it is busy, nothing is started for it.
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    // A command-line turn the gateway ran for it is over: idle at once, not only after kTurnSeconds.
    REQUIRE(f.delivery.turn_ended({{"window_id", cut.window_id}}).at("idle") == true);
    REQUIRE(f.delivery.turn_ended({{"window_id", cut.window_id}}).at("idle") == false);
    f.pass(acm::Delivery::kSettleSeconds + 1);
    {
        const json now = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
        REQUIRE(now.size() == 1);
        f.delivery.report({{"delivery_id", now.at(0).at("delivery_id")}, {"ok", false}, {"postponed", true}});
    }
    f.pass(acm::Windows::kTurnSeconds);
    // Unless its client has used up its quota: then nothing is started for it until the vendor's time.
    const std::string until = acm::to_rfc3339(f.time.clock()() + std::chrono::hours(2));
    f.delivery.set_limit({{"client", "codex"}, {"until", until}, {"detail", "usage limit"}});
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    REQUIRE(f.delivery.limit_of("codex").at("until") == until);
    REQUIRE(f.delivery.limit_of("claude").is_null());
    // When the time has passed the mark is gone by itself.
    f.pass(2 * 3600 + 1);
    REQUIRE(f.delivery.limits().empty());
    const json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-cut");
    // Clearing it by hand works too, and updating retry time emits a fresh event while repeats stay quiet.
    const std::string t1 = acm::to_rfc3339(f.time.clock()() + std::chrono::hours(1));
    const std::string t2 = acm::to_rfc3339(f.time.clock()() + std::chrono::hours(3));
    const auto count_events = [&](std::string_view type) {
        acm::Statement q = f.database.query("SELECT COUNT(*) FROM events WHERE event_type = ?", type);
        q.step();
        return q.integer(0);
    };
    const std::int64_t before_exhausted = count_events("client.quota_exhausted");
    f.delivery.set_limit({{"client", "codex"}, {"until", t1}});
    f.delivery.set_limit({{"client", "codex"}, {"until", t1}});
    REQUIRE(count_events("client.quota_exhausted") == before_exhausted + 1);
    f.delivery.set_limit({{"client", "codex"}, {"until", t2}});
    REQUIRE(count_events("client.quota_exhausted") == before_exhausted + 2);
    const std::int64_t before_restored = count_events("client.quota_restored");
    REQUIRE(f.delivery.set_limit({{"client", "codex"}}).empty());
    REQUIRE(count_events("client.quota_restored") == before_restored + 1);
}

TEST_CASE("a read that cannot be placed in a window leaves what was addressed to a window unread for it", "[window][cursor]") {
    Fixture f;
    const acm::Window lead = f.open(f.claude, "claude", "conv-lead");
    f.hook(f.codex, "codex", "thread-a", "stop");
    f.hook(f.codex, "codex", "thread-b", "stop");
    const acm::Window a = f.open(f.codex, "codex", "thread-a");
    const acm::Window b = f.open(f.codex, "codex", "thread-b");
    f.say(f.claude, &lead, "for everybody");
    const json addressed = f.say(f.claude, &lead, "a: only you", false, {a});
    const std::int64_t last = f.say(f.claude, &lead, "for everybody again").at("sequence").get<std::int64_t>();
    // Codex catches up without saying which of its windows reads (an older bridge, a helper).
    f.messages.advance_cursor(f.codex, f.lobby, last);
    // Window b is shown nothing more; window a still gets what was meant for it.
    REQUIRE(f.hook(f.codex, "codex", "thread-b", "prompt", {{"peek", true}}).at("count") == 0);
    const json shown = f.hook(f.codex, "codex", "thread-a", "prompt", {{"peek", true}});
    REQUIRE(shown.at("text").get<std::string>().contains("a: only you"));
    REQUIRE_FALSE(shown.at("text").get<std::string>().contains("for everybody\n"));
    (void)addressed;
    (void)b;
}

TEST_CASE("an urgent message for a session goes to one of its windows, and not to the sender's others", "[window][urgent]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    // Two idle Codex threads; Claude has the window that coordinates and one that does something else.
    f.hook(f.codex, "codex", "thread-old", "stop");
    f.pass(60);
    f.hook(f.codex, "codex", "thread-new", "stop");
    const acm::Window coordinator = f.open(f.claude, "claude", "conv-coordinator");
    f.hook(f.claude, "claude", "conv-coordinator", "prompt");
    f.hook(f.claude, "claude", "conv-busy-elsewhere", "prompt");
    f.pass(acm::Delivery::kSettleSeconds);

    // For Codex as such: the thread it used last is started, the other is left alone.
    f.tell(f.claude, f.codex, "codex: one of you check the build", &coordinator);
    const json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-new");
    f.delivery.report({{"delivery_id", jobs.at(0).at("delivery_id")}, {"ok", true}});
    // Once: the older thread is not interrupted with it when it is the one that acts next.
    f.pass(acm::Delivery::kMinIntervalSeconds + 1);
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    REQUIRE(f.hook(f.codex, "codex", "thread-old", "stop").at("count") == 0);

    // What the coordinator wrote to somebody else never interrupts Claude's own other window.
    REQUIRE(f.hook(f.claude, "claude", "conv-busy-elsewhere", "stop").at("count") == 0);
    // Not even in a direct conversation, where both sides are "the session alone".
    const std::string channel = f.conversations.direct(f.claude, f.codex.session_id).at("conversation_id");
    const json direct = f.messages.send(
        f.claude, {{"conversation_id", channel}, {"body", "codex: click the page"}, {"urgent", true}, {"idempotency_key", "dm-1"}},
        &coordinator);
    REQUIRE_FALSE(direct.contains("urgent_note"));
    REQUIRE(f.hook(f.claude, "claude", "conv-busy-elsewhere", "stop").at("count") == 0);
    REQUIRE(f.hook(f.claude, "claude", "conv-coordinator", "stop").at("count") == 0);
    // It is the other side that is interrupted, in the thread it used last.
    const json reached = f.hook(f.codex, "codex", "thread-old", "stop");
    REQUIRE(reached.at("count") == 1);
    REQUIRE(reached.at("text").get<std::string>().contains("click the page"));
}

TEST_CASE("kept messages come along within a size, the newest ones, and old ones as overviews", "[window][bounds]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    const std::string filler(3000, 's');
    // A third session that reads nothing of what follows until a day later.
    const acm::Session late = f.join("antigravity");
    // Twenty-four messages, fourteen of them long specifications that the coordinator keeps.
    json keep = json::array();
    for (int i = 1; i <= 24; ++i) {
        f.say(f.claude, nullptr, i <= 14 ? "KEPT-" + std::to_string(i) + " " + filler : "report number " + std::to_string(i));
        if (i <= 14) {
            keep.push_back(i);
        }
    }
    f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"summary", "DIGEST: fourteen specifications."}, {"keep", keep}},
                            "coord");
    const auto text_of = [](const json& messages) {
        std::size_t total = 0;
        for (const auto& message : messages) {
            total += message.at("body").get<std::string>().size();
        }
        return total;
    };

    // A reader that was behind all of it: the newest twelve, and it is told that there are more.
    const acm::Window reader = f.open(f.codex, "codex", "conv-a");
    json page = f.messages.unread(f.codex, f.lobby, 15, &reader);
    const json& kept = page.at("kept_messages");
    REQUIRE(kept.size() == static_cast<std::size_t>(acm::Messages::kKeptListed));
    REQUIRE(page.at("kept_not_listed") == true);
    REQUIRE(kept.at(0).at("body").get<std::string>().starts_with("KEPT-3 "));
    REQUIRE(kept.back().at("body").get<std::string>().starts_with("KEPT-14 "));
    // The newest are whole; once the size of a check-in is spent, the earlier ones are overviews.
    REQUIRE_FALSE(kept.back().contains("cut"));
    REQUIRE(kept.at(0).at("cut") == true);
    REQUIRE(text_of(kept) <= acm::Messages::kCheckInBytes + kept.size() * 600);

    // A day later the same messages are history for a reader that comes to them only now:
    // it is told that they are there, in a few lines each.
    f.pass(acm::Messages::kKeptFreshSeconds + 60);
    page = f.messages.unread(late, f.lobby, 15);
    for (const auto& message : page.at("kept_messages")) {
        REQUIRE(message.at("cut") == true);
        REQUIRE(message.at("body").get<std::string>().size() < 600);
    }
    REQUIRE(text_of(page.at("kept_messages")) < 8000);
    // Asked for by id, one of them is whole.
    const std::string id = page.at("kept_messages").back().at("message_id");
    const json whole = f.messages.read(late, {{"conversation_id", f.lobby}, {"message_ids", {id}}});
    REQUIRE(whole.at("messages").at(0).at("body").get<std::string>().size() > 3000);
}

TEST_CASE("compacting decides what of a conversation is still read into a context", "[window][compact]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    // Thirty messages in the lobby; Codex has read none of them.
    for (int i = 1; i <= 30; ++i) {
        f.say(f.claude, nullptr, i == 3 ? "SPEC: tables use UTC and SHA-256" : i == 5 ? "test chatter, ignore" : "report number " + std::to_string(i));
    }
    // The coordinator compacts: a digest of all of it, the specification stays readable in full, the chatter goes.
    json done = f.conversations.compact(&f.claude, {{"conversation_id", f.lobby},
                                                    {"summary", "DIGEST-1: thirty reports are in; the build is green."},
                                                    {"keep", {3}},
                                                    {"drop", {5}}},
                                        "coord");
    REQUIRE(done.at("digest").at("upto_seq") == 30);
    REQUIRE(done.at("digest").at("by") == "coord");
    REQUIRE(done.at("kept_messages") == 1);
    REQUIRE(done.at("dropped_messages") == 1);

    // In its client's hooks a window that was behind is shown the digest once, the kept message, and no history.
    const json first = f.hook(f.codex, "codex", "conv-a", "prompt");
    const std::string shown = first.at("text");
    REQUIRE(shown.contains("Digest of the lobby up to message 30, written by coord"));
    REQUIRE(shown.contains("DIGEST-1: thirty reports are in"));
    REQUIRE(shown.contains("SPEC: tables use UTC and SHA-256"));
    REQUIRE_FALSE(shown.contains("report number 7"));
    REQUIRE_FALSE(shown.contains("test chatter"));
    REQUIRE(first.at("count") == 1);
    REQUIRE(f.hook(f.codex, "codex", "conv-a", "prompt").at("text") == "");

    // The same in check_in: the digest in place of the history, the kept message with it.
    f.say(f.claude, nullptr, "report number 31");
    const acm::Window reader = f.open(f.codex, "codex", "conv-b");
    json page = f.messages.unread(f.codex, f.lobby, 15, &reader);
    REQUIRE(page.at("digest").at("text") == "DIGEST-1: thirty reports are in; the build is green.");
    REQUIRE(page.at("messages").size() == 1);
    REQUIRE(page.at("messages").at(0).at("body") == "report number 31");
    REQUIRE(page.at("kept_messages").size() == 1);
    REQUIRE(page.at("kept_messages").at(0).at("context") == "kept");
    REQUIRE(page.at("skipped_earlier") == 0);
    // Read is read: nothing of it comes again.
    page = f.messages.unread(f.codex, f.lobby, 15, &reader);
    REQUIRE(page.at("messages").empty());
    REQUIRE_FALSE(page.contains("digest"));
    // The history is all there for whoever asks for it, with what was done to each message.
    const json history = f.messages.read(f.codex, {{"conversation_id", f.lobby}, {"after_seq", 0}, {"limit", 10}});
    REQUIRE(history.at("messages").at(4).at("context") == "dropped");
    REQUIRE(history.at("messages").at(2).at("context") == "kept");

    // A new digest has to be worth it; restructuring the one that exists, and keep, drop, restore, work any time.
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"summary", "too soon"}}, "coord"); }) ==
            "DIGEST_NOT_NEEDED");
    done = f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"summary", "DIGEST-1b: restructured."}, {"upto_seq", 30}, {"restore", {5}}}, "coord");
    REQUIRE(done.at("digest").at("text") == "DIGEST-1b: restructured.");
    REQUIRE(done.at("dropped_messages") == 0);
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"drop", {999}}}, "coord"); }) == "NOT_FOUND");
    // What was dealt with is resolved: out of everybody's context like what was dropped, and marked as settled.
    f.say(f.claude, nullptr, "REQUEST: rerun table 4");
    done = f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"resolve", {32}}}, "coord");
    REQUIRE(done.at("resolved_messages") == 1);
    REQUIRE_FALSE(f.hook(f.codex, "codex", "conv-c", "prompt").at("text").get<std::string>().contains("rerun table 4"));
    REQUIRE(f.messages.unread(f.codex, f.lobby, 15, &reader).at("messages").empty());
    REQUIRE(f.messages.read(f.codex, {{"conversation_id", f.lobby}, {"after_seq", 31}, {"limit", 5}}).at("messages").at(0).at("context") == "resolved");
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"keep", {4}}, {"drop", {4}}}, "coord"); }) ==
            "INVALID_ARGUMENT");

    // What the operator wrote is not for a session to take out of sight; the operator can.
    f.messages.send_as_operator({{"conversation_id", f.lobby}, {"body", "operator: figures by Friday"}, {"idempotency_key", "op-1"}});
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"drop", {33}}}, "coord"); }) ==
            "COMPACT_NOT_ALLOWED");
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"resolve", {33}}}, "coord"); }) ==
            "COMPACT_NOT_ALLOWED");
    REQUIRE(f.conversations.compact(nullptr, {{"conversation_id", f.lobby}, {"resolve", {33}}}, "the operator").at("resolved_messages") == 2);
    // And the operator can keep compacting to the console altogether.
    acm::store_text_setting(f.database, "agent_compact", "0");
    REQUIRE(error_code([&] { f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"keep", {4}}}, "coord"); }) ==
            "COMPACT_DISABLED");
}

TEST_CASE("a reader that is far behind is given the newest messages, not the history", "[window][compact]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    const acm::Window coordinator = f.open(f.claude, "claude", "conv-coord");
    const std::string long_text(2000, 'x');
    for (int i = 1; i <= 70; ++i) {
        f.say(f.claude, &coordinator, i == 70 ? long_text : "note " + std::to_string(i));
    }
    const acm::Window reader = f.open(f.codex, "codex", "thread-r");
    // No digest yet: the newest fifteen, and a count of what was left out.
    const json page = f.messages.unread(f.codex, f.lobby, 15, &reader);
    REQUIRE(page.at("messages").size() == 15);
    REQUIRE(page.at("messages").at(0).at("body") == "note 56");
    REQUIRE(page.at("skipped_earlier") == 55);
    // A long message that is not addressed to the reader comes as an overview.
    const json last = page.at("messages").at(14);
    REQUIRE(last.at("cut") == true);
    REQUIRE(last.at("body").get<std::string>().size() < 600);
    REQUIRE(last.at("body").get<std::string>().ends_with("[... cut; read_messages has the rest]"));
    // Much was said and nobody summarized it: the one who wrote most is told that a digest is due.
    REQUIRE(f.conversations.digest_due(f.claude, f.lobby, &coordinator.window_id) == true);
    REQUIRE(f.conversations.digest_due(f.codex, f.lobby, &reader.window_id) == false);
    const acm::Window other = f.open(f.claude, "claude", "conv-other");
    REQUIRE(f.conversations.digest_due(f.claude, f.lobby, &other.window_id) == false);
    f.conversations.compact(&f.claude, {{"conversation_id", f.lobby}, {"summary", "seventy notes"}}, "coord");
    REQUIRE(f.conversations.digest_due(f.claude, f.lobby, &coordinator.window_id) == false);
}

TEST_CASE("hooks put little in front of a window that is not addressed", "[window][compact]") {
    Fixture f;
    acm::set_message_limits(f.database, {.per_minute = 0, .per_hour = 0, .duplicate_window_seconds = 0, .urgent_per_hour = 0});
    const acm::Window coordinator = f.open(f.claude, "claude", "conv-coord");
    const acm::Window hy = f.open(f.codex, "codex", "thread-hy");
    const acm::Window nbs = f.open(f.codex, "codex", "thread-nbs");
    const std::string report = "LONG-REPORT " + std::string(1000, 'r') + " END-OF-REPORT";
    // A long message for one window: that window gets it in full, the other an overview.
    f.say(f.claude, &coordinator, report, false, {hy});
    f.say(f.claude, &coordinator, report + " (to everybody)");
    const std::string for_hy = f.hook(f.codex, "codex", "thread-hy", "prompt").at("text");
    REQUIRE(for_hy.contains("END-OF-REPORT"));
    const std::string for_nbs = f.hook(f.codex, "codex", "thread-nbs", "prompt").at("text");
    REQUIRE(for_nbs.contains("LONG-REPORT"));
    REQUIRE_FALSE(for_nbs.contains("END-OF-REPORT"));
    REQUIRE(for_nbs.size() < 900);

    // A direct conversation belongs to the window that writes in it: Claude's other windows are not shown its traffic.
    const std::string channel = f.conversations.direct(f.claude, f.codex.session_id).at("conversation_id");
    f.messages.send(f.claude, {{"conversation_id", channel}, {"body", "codex: status?"}, {"idempotency_key", "d-1"}}, &coordinator);
    f.messages.send(f.codex, {{"conversation_id", channel}, {"body", "PRIVATE-REPLY for the coordinator"}, {"idempotency_key", "d-2"}}, &hy);
    REQUIRE_FALSE(f.hook(f.claude, "claude", "conv-elsewhere", "prompt").at("text").get<std::string>().contains("PRIVATE-REPLY"));
    REQUIRE(f.hook(f.claude, "claude", "conv-coord", "prompt").at("text").get<std::string>().contains("PRIVATE-REPLY"));
    // The same on the other side: the thread that answered sees what comes next, its sibling does not.
    f.messages.send(f.claude, {{"conversation_id", channel}, {"body", "FOLLOW-UP for hy"}, {"idempotency_key", "d-3"}}, &coordinator);
    REQUIRE_FALSE(f.hook(f.codex, "codex", "thread-nbs", "prompt").at("text").get<std::string>().contains("FOLLOW-UP"));
    REQUIRE(f.hook(f.codex, "codex", "thread-hy", "prompt").at("text").get<std::string>().contains("FOLLOW-UP"));

    // A roster names the windows used last, the caller's own first, and says how many more there are.
    for (int i = 0; i < 9; ++i) {
        f.pass(1);
        f.open(f.codex, "codex", "thread-extra-" + std::to_string(i));
    }
    const json listed = f.windows.of_session(f.codex.session_id, &hy, acm::Windows::kRosterWindows);
    REQUIRE(listed.size() == 8);
    REQUIRE(listed.at(0).at("is_you") == true);
    REQUIRE(f.windows.count_of_session(f.codex.session_id) == 11);
}

TEST_CASE("the operator's shared rules reach every conversation once per version", "[window][rules]") {
    Fixture f;
    acm::store_text_setting(f.database, "shared_rules", "Authorization pages are clicked by Grok Bot.");
    acm::store_text_setting(f.database, "shared_rules_at", "2026-11-21T09:00:00.000Z");
    // A conversation is told when it starts, with nothing else to say.
    const json start = f.hook(f.codex, "codex", "thread-1", "start");
    REQUIRE(start.at("count") == 0);
    REQUIRE(start.at("rules") == true);
    const std::string text = start.at("text");
    REQUIRE(text.starts_with("[ACM] Shared rules for every session on this machine."));
    REQUIRE(text.contains("person who runs these sessions"));
    REQUIRE(text.contains("Authorization pages are clicked by Grok Bot."));
    // Not again with every prompt, and never at the end of a turn.
    REQUIRE(f.hook(f.codex, "codex", "thread-1", "prompt").at("text") == "");
    REQUIRE(f.hook(f.codex, "codex", "thread-1", "stop").at("text") == "");
    // Another conversation is told by itself; with messages, the rules come first.
    f.say(f.claude, nullptr, "hello codex");
    const json other = f.hook(f.codex, "codex", "thread-2", "prompt");
    REQUIRE(other.at("count") == 1);
    REQUIRE(other.at("text").get<std::string>().find("Shared rules") < other.at("text").get<std::string>().find("hello codex"));
    // Changed rules are told again; removed rules are not.
    acm::store_text_setting(f.database, "shared_rules", "New rule.");
    acm::store_text_setting(f.database, "shared_rules_at", "2026-11-21T10:00:00.000Z");
    REQUIRE(f.hook(f.codex, "codex", "thread-1", "prompt").at("text").get<std::string>().contains("New rule."));
    acm::erase_setting(f.database, "shared_rules");
    acm::store_text_setting(f.database, "shared_rules_at", "2026-11-21T11:00:00.000Z");
    REQUIRE(f.hook(f.codex, "codex", "thread-1", "prompt").at("text") == "");
}

TEST_CASE("a window known only from its tool calls can still be woken", "[window][urgent]") {
    Fixture f;
    // Its client runs no hooks for it (not reviewed yet), but its bridge said which conversation it is.
    const acm::Window quiet = f.open(f.codex, "codex", "thread-quiet");
    f.tell(f.claude, f.codex, "are you there");
    // It called a tool this moment: it is in a turn and will see the message by itself.
    REQUIRE(f.delivery.claim({{"clients", {"codex"}}}).at("jobs").empty());
    f.pass(acm::Delivery::kToolIdleSeconds);
    const json jobs = f.delivery.claim({{"clients", {"codex"}}}).at("jobs");
    REQUIRE(jobs.size() == 1);
    REQUIRE(jobs.at(0).at("client_session") == "thread-quiet");
    REQUIRE(f.windows.view(quiet.window_id).at("hooked") == false);
}
