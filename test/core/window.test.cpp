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
