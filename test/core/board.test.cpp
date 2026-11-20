// Tests for src/core/board: the shared task board of a conversation.
#include "core/board.hpp"
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
    acm::Board board{database, events, conversations, time.clock()};
    acm::Session lead;
    acm::Session worker;
    acm::Session viewer;
    acm::Session outsider;
    std::string conversation;

    Fixture() {
        conversations.create_project({{"project_id", "prj_alpha"}, {"name", "Alpha"}});
        identity.create_agent({{"agent_id", "agt"}, {"provider", "test"}, {"client_kind", "test"}, {"display_name", "Agent"}});
        lead = active("lead");
        worker = active("worker");
        viewer = active("viewer");
        outsider = active("outsider");
        conversation = conversations
                           .create_conversation({{"project_id", "prj_alpha"}, {"task_code", "DATA-014"}, {"title", "t"}})
                           .at("conversation_id");
        conversations.set_members(conversation,
                                  {{"expected_version", 1},
                                   {"members",
                                    {{{"session_id", lead.session_id}},
                                     {{"session_id", worker.session_id}},
                                     {{"session_id", viewer.session_id}, {"can_write", false}}}}});
    }

    acm::Session active(const std::string& label) {
        const json pairing = identity.create_pairing({{"agent_id", "agt"}, {"project_id", "prj_alpha"}, {"label", label}});
        const std::string token = pairing.at("token");
        identity.request_pairing(identity.authenticate(token), {{"client_kind", "test"}});
        identity.approve_pairing(pairing.at("session_id").get<std::string>());
        return identity.authenticate(token);
    }

    json create(const acm::Session& as, const std::string& title, json extra = json::object()) {
        json args = {{"conversation_id", conversation}, {"title", title}};
        args.update(extra);
        return board.create_task(as, args);
    }

    std::vector<std::string> titles(const acm::Session& as, bool include_closed = false) {
        std::vector<std::string> list;
        // Keep the result alive: iterating a member of a temporary would dangle.
        const json result = board.list_tasks(as, {{"conversation_id", conversation}, {"include_closed", include_closed}});
        for (const auto& task : result.at("tasks")) {
            list.push_back(task.at("title").get<std::string>());
        }
        return list;
    }
};

}  // namespace

TEST_CASE("tasks are numbered per conversation and never duplicated by title", "[board][create]") {
    Fixture f;
    const json first = f.create(f.lead, "Clean raw readings", {{"detail", "12 rows in raw/readings.csv"}});
    REQUIRE(first.at("number") == 1);
    REQUIRE(first.at("status") == "todo");
    REQUIRE(first.at("assignee").is_null());
    REQUIRE(first.at("created_by") == f.lead.session_id);
    REQUIRE(first.at("already_exists") == false);

    // Creating with an assignee starts the task at once.
    const json second = f.create(f.worker, "Verify row count", {{"assignee_session_id", "me"}});
    REQUIRE(second.at("number") == 2);
    REQUIRE(second.at("status") == "doing");
    REQUIRE(second.at("assignee").at("session_id") == f.worker.session_id);
    REQUIRE(second.at("assignee").at("label") == "worker");

    // Two agents adding the same open task end up with one entry.
    const json repeat = f.create(f.worker, "Clean raw readings");
    REQUIRE(repeat.at("task_id") == first.at("task_id"));
    REQUIRE(repeat.at("already_exists") == true);
    REQUIRE(f.titles(f.viewer) == std::vector<std::string>{"Clean raw readings", "Verify row count"});
}

TEST_CASE("members claim, report and close tasks; closed ones leave the open board", "[board][update]") {
    Fixture f;
    const std::string task_id = f.create(f.lead, "Clean raw readings").at("task_id");
    f.create(f.lead, "Write handoff summary");

    const json claimed = f.board.update_task(f.worker, {{"task_id", task_id}, {"assignee_session_id", "me"}});
    REQUIRE(claimed.at("status") == "doing");
    REQUIRE(claimed.at("assignee").at("session_id") == f.worker.session_id);
    REQUIRE(claimed.at("version") == 2);

    const json blocked = f.board.update_task(f.worker, {{"task_id", task_id}, {"status", "blocked"}, {"note", "file is locked"}});
    REQUIRE(blocked.at("status") == "blocked");
    REQUIRE(blocked.at("note") == "file is locked");
    REQUIRE(blocked.at("updated_by") == f.worker.session_id);

    const json done = f.board.update_task(f.worker, {{"task_id", task_id}, {"status", "done"}, {"note", "12 -> 8 rows"}});
    REQUIRE(done.at("status") == "done");
    REQUIRE(f.titles(f.lead) == std::vector<std::string>{"Write handoff summary"});
    REQUIRE(f.titles(f.lead, true) == std::vector<std::string>{"Write handoff summary", "Clean raw readings"});
    // A finished title may be used again for new work.
    REQUIRE(f.create(f.lead, "Clean raw readings").at("already_exists") == false);

    // Releasing with null keeps the status the caller chose.
    const std::string other = f.create(f.lead, "Review", {{"assignee_session_id", f.worker.session_id}}).at("task_id");
    const json released = f.board.update_task(f.worker, {{"task_id", other}, {"assignee_session_id", nullptr}, {"status", "todo"}});
    REQUIRE(released.at("assignee").is_null());
    REQUIRE(released.at("status") == "todo");
}

TEST_CASE("a stale update is refused with the current task", "[board][versions]") {
    Fixture f;
    const std::string task_id = f.create(f.lead, "Dedupe").at("task_id");
    // Both agents read version 1; the first claim wins.
    f.board.update_task(f.worker, {{"task_id", task_id}, {"assignee_session_id", "me"}, {"expected_version", 1}});
    try {
        f.board.update_task(f.lead, {{"task_id", task_id}, {"assignee_session_id", "me"}, {"expected_version", 1}});
        FAIL("expected VERSION_CONFLICT");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "VERSION_CONFLICT");
        REQUIRE(error.details().at("current").at("assignee").at("session_id") == f.worker.session_id);
        REQUIRE(error.details().at("current").at("version") == 2);
    }
    REQUIRE(f.board.update_task(f.lead, {{"task_id", task_id}, {"note", "ok, yours"}, {"expected_version", 2}}).at("version") == 3);
}

TEST_CASE("the board follows conversation permissions", "[board][permissions]") {
    Fixture f;
    const std::string task_id = f.create(f.lead, "Clean raw readings").at("task_id");

    REQUIRE_NOTHROW(f.titles(f.viewer));
    REQUIRE(error_code([&] { f.create(f.viewer, "read-only cannot add"); }) == "WRITE_DENIED");
    REQUIRE(error_code([&] { f.board.update_task(f.viewer, {{"task_id", task_id}, {"status", "done"}}); }) == "WRITE_DENIED");
    REQUIRE(error_code([&] { f.titles(f.outsider); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.create(f.outsider, "not a member"); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.board.update_task(f.outsider, {{"task_id", task_id}, {"status", "done"}}); }) == "NOT_MEMBER");

    REQUIRE(error_code([&] { f.create(f.lead, "assign outside", {{"assignee_session_id", f.outsider.session_id}}); }) == "INVALID_ASSIGNEE");
    REQUIRE(error_code([&] { f.board.update_task(f.lead, {{"task_id", task_id}, {"status", "almost"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.board.update_task(f.lead, {{"task_id", task_id}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.board.update_task(f.lead, {{"task_id", "tsk_missing"}, {"status", "done"}}); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.create(f.lead, ""); }) == "INVALID_ARGUMENT");
    REQUIRE(f.board.tasks(f.conversation, true).size() == 1);
    REQUIRE(f.board.tasks(f.conversation, true).at(0).at("status") == "todo");
}

TEST_CASE("the operator edits the same board and every change is an event", "[board][operator]") {
    Fixture f;
    const auto before = f.events.watermark();
    const json created = f.board.admin_create_task(f.conversation, {{"title", "Archive when verified"}, {"assignee_session_id", f.lead.session_id}});
    REQUIRE(created.at("created_by").is_null());
    REQUIRE(created.at("assignee").at("label") == "lead");
    const std::string task_id = created.at("task_id");
    const json updated = f.board.admin_update_task(task_id, {{"status", "cancelled"}, {"note", "no longer needed"}});
    REQUIRE(updated.at("status") == "cancelled");
    REQUIRE(updated.at("updated_by").is_null());

    REQUIRE(error_code([&] { f.board.admin_create_task(f.conversation, {{"title", "x"}, {"assignee_session_id", "me"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.board.admin_create_task("cnv_missing", {{"title", "x"}}); }) == "NOT_FOUND");

    std::vector<std::string> types;
    for (const auto& event : f.events.read_after(before, 10)) {
        types.push_back(event.at("event_type").get<std::string>());
        REQUIRE(event.at("conversation_id") == f.conversation);
        // Events identify the task; its title and notes stay in the store.
        REQUIRE_FALSE(event.dump().contains("Archive"));
    }
    REQUIRE(types == std::vector<std::string>{"task.created", "task.updated"});
}

TEST_CASE("a task one session holds cannot be claimed by another", "[board][claim]") {
    Fixture f;
    const std::string task_id = f.create(f.lead, "Clean raw readings").at("task_id");

    // Two sessions claim one after the other, both the recommended way.
    const json won = f.board.update_task(f.worker, {{"task_id", task_id}, {"assignee_session_id", "me"}});
    REQUIRE(won.at("assignee").at("session_id") == f.worker.session_id);
    try {
        f.board.update_task(f.lead, {{"task_id", task_id}, {"assignee_session_id", "me"}});
        FAIL("the second claim must be refused");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "ALREADY_CLAIMED");
        // The loser is told who holds the task.
        REQUIRE(error.details().at("current").at("assignee").at("session_id") == f.worker.session_id);
    }
    // Nothing changed: same holder, same version, no extra event.
    const json after = f.board.tasks(f.conversation, true).at(0);
    REQUIRE(after.at("assignee").at("session_id") == f.worker.session_id);
    REQUIRE(after.at("version") == won.at("version"));
    // Others can neither hand it on nor release it.
    REQUIRE(error_code([&] {
                f.board.update_task(f.lead, {{"task_id", task_id}, {"assignee_session_id", f.lead.session_id}});
            }) == "ALREADY_CLAIMED");
    REQUIRE(error_code([&] { f.board.update_task(f.lead, {{"task_id", task_id}, {"assignee_session_id", nullptr}}); }) ==
            "ALREADY_CLAIMED");
    // They can still add a note, and the holder claiming again is harmless.
    REQUIRE_NOTHROW(f.board.update_task(f.lead, {{"task_id", task_id}, {"note", "input file is ready"}}));
    REQUIRE_NOTHROW(f.board.update_task(f.worker, {{"task_id", task_id}, {"assignee_session_id", "me"}}));

    // After the holder releases it, the next claim succeeds; the operator may always reassign.
    f.board.update_task(f.worker, {{"task_id", task_id}, {"assignee_session_id", nullptr}});
    REQUIRE(f.board.update_task(f.lead, {{"task_id", task_id}, {"assignee_session_id", "me"}})
                .at("assignee")
                .at("session_id") == f.lead.session_id);
    REQUIRE(f.board.admin_update_task(task_id, {{"assignee_session_id", f.worker.session_id}})
                .at("assignee")
                .at("session_id") == f.worker.session_id);
}