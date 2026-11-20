// Tests for src/core/conversation: projects, conversations, membership,
// read/write permissions, cross-project isolation and version conflicts.
#include "core/board.hpp"
#include "core/conversation.hpp"
#include "core/delivery.hpp"
#include "core/message.hpp"
#include "core/progress.hpp"
#include "core/settings.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <map>

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
    std::map<std::string, std::string> tokens;

    Fixture() {
        conversations.create_project({{"project_id", "prj_alpha"}, {"name", "Alpha"}});
        conversations.create_project({{"project_id", "prj_beta"}, {"name", "Beta"}});
        identity.create_agent({{"agent_id", "agt_codex"},
                               {"provider", "openai"},
                               {"client_kind", "codex-desktop"},
                               {"display_name", "Codex"}});
    }

    // Creates a pairing and walks it to `active`.
    acm::Session active_session(const std::string& label, const std::string& project_id = "prj_alpha") {
        const json pairing =
            identity.create_pairing({{"agent_id", "agt_codex"}, {"project_id", project_id}, {"label", label}});
        const std::string token = pairing.at("token");
        identity.request_pairing(identity.authenticate(token), {{"client_kind", "codex-desktop"}});
        identity.approve_pairing(pairing.at("session_id").get<std::string>());
        tokens[pairing.at("session_id").get<std::string>()] = token;
        return identity.authenticate(token);
    }

    // The same credential authenticated again, to pick up operator changes.
    acm::Session reload(const acm::Session& session) { return identity.authenticate(tokens.at(session.session_id)); }

    std::string conversation(const std::string& task_code = "DATA-014") {
        return conversations
            .create_conversation({{"project_id", "prj_alpha"}, {"task_code", task_code}, {"title", "CSV handoff"}})
            .at("conversation_id");
    }
};

json member(const acm::Session& session, bool can_read = true, bool can_write = true) {
    return {{"session_id", session.session_id}, {"can_read", can_read}, {"can_write", can_write}};
}

}  // namespace

TEST_CASE("projects and conversations are created once and validated", "[conversation][create]") {
    Fixture f;
    const json created = f.conversations.create_conversation(
        {{"project_id", "prj_alpha"}, {"task_code", "DATA-014"}, {"title", "CSV handoff"}, {"purpose", "clean"}});
    REQUIRE(created.at("config_version") == 1);
    REQUIRE(created.at("last_seq") == 0);
    REQUIRE(created.at("members").empty());
    REQUIRE(created.at("status") == "open");

    REQUIRE(error_code([&] { f.conversation("DATA-014"); }) == "ALREADY_EXISTS");
    REQUIRE(error_code([&] {
                f.conversations.create_conversation(
                    {{"project_id", "prj_missing"}, {"task_code", "X-1"}, {"title", "t"}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.conversations.create_project({{"project_id", "prj_alpha"}, {"name", "dup"}}); }) ==
            "ALREADY_EXISTS");
    REQUIRE(error_code([&] { f.conversations.create_conversation({{"project_id", "prj_alpha"}}); }) ==
            "INVALID_ARGUMENT");
    // The same task code may exist in a different project.
    REQUIRE_NOTHROW(f.conversations.create_conversation(
        {{"project_id", "prj_beta"}, {"task_code", "DATA-014"}, {"title", "other project"}}));
    REQUIRE(f.conversations.list_all().size() == 2);
}

TEST_CASE("read and write permissions are enforced per member", "[conversation][permissions]") {
    Fixture f;
    const auto writer = f.active_session("writer");
    const auto reader = f.active_session("read only");
    const auto poster = f.active_session("write only");
    const auto id = f.conversation();
    const json updated = f.conversations.set_members(
        id, {{"expected_version", 1},
             {"members", {member(writer), member(reader, true, false), member(poster, false, true)}}});
    REQUIRE(updated.at("config_version") == 2);
    REQUIRE(updated.at("members").size() == 3);

    REQUIRE_NOTHROW(f.conversations.require_writer(writer, id));
    REQUIRE_NOTHROW(f.conversations.require_reader(writer, id));
    REQUIRE_NOTHROW(f.conversations.require_reader(reader, id));
    REQUIRE(error_code([&] { f.conversations.require_writer(reader, id); }) == "WRITE_DENIED");
    REQUIRE_NOTHROW(f.conversations.require_writer(poster, id));
    REQUIRE(error_code([&] { f.conversations.require_reader(poster, id); }) == "READ_DENIED");

    const json mine = f.conversations.list_for_session(reader);
    REQUIRE(mine.size() == 1);
    REQUIRE(mine.at(0).at("can_read") == true);
    REQUIRE(mine.at(0).at("can_write") == false);
    REQUIRE(f.conversations.get_for_session(reader, id).at("your_access").at("can_write") == false);
    REQUIRE(f.conversations.readers(id) ==
            [&] {
                std::vector<std::string> expected{writer.session_id, reader.session_id};
                std::sort(expected.begin(), expected.end());
                return expected;
            }());
}

TEST_CASE("a second session of the same agent family has no access unless added", "[conversation][isolation]") {
    Fixture f;
    const auto authorized = f.active_session("codex window 1");
    const auto sibling = f.active_session("codex window 2");
    const auto id = f.conversation();
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(authorized)}}});

    REQUIRE(authorized.agent_id == sibling.agent_id);
    REQUIRE_NOTHROW(f.conversations.require_reader(authorized, id));
    REQUIRE(error_code([&] { f.conversations.require_member(sibling, id); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.conversations.get_for_session(sibling, id); }) == "NOT_MEMBER");
    REQUIRE(f.conversations.list_for_session(sibling).empty());
    // A conversation that does not exist is indistinguishable from one the caller cannot see.
    REQUIRE(error_code([&] { f.conversations.require_member(sibling, "cnv_missing"); }) == "NOT_MEMBER");
}

TEST_CASE("sessions bound to another project cannot be added or read across", "[conversation][cross-project]") {
    Fixture f;
    const auto local = f.active_session("alpha session");
    const auto foreign = f.active_session("beta session", "prj_beta");
    const auto id = f.conversation();
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(local)}}});

    REQUIRE(error_code([&] {
                f.conversations.set_members(id, {{"expected_version", 2}, {"members", {member(local), member(foreign)}}});
            }) == "CROSS_PROJECT");
    // The rejected update changed nothing.
    const json current = f.conversations.get(id);
    REQUIRE(current.at("config_version") == 2);
    REQUIRE(current.at("members").size() == 1);
    REQUIRE(error_code([&] { f.conversations.require_member(foreign, id); }) == "NOT_MEMBER");
    REQUIRE(f.conversations.list_for_session(foreign).empty());
}

TEST_CASE("two editors of the same member list get an explainable version conflict", "[conversation][versions]") {
    Fixture f;
    const auto first = f.active_session("first");
    const auto second = f.active_session("second");
    const auto id = f.conversation();

    // Both consoles loaded version 1; the first save wins.
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(first)}}});
    try {
        f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(second)}}});
        FAIL("expected VERSION_CONFLICT");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "VERSION_CONFLICT");
        const json& current = error.details().at("current");
        REQUIRE(current.at("config_version") == 2);
        REQUIRE(current.at("members").size() == 1);
        REQUIRE(current.at("members").at(0).at("session_id") == first.session_id);
    }
    REQUIRE(error_code([&] { f.conversations.require_member(second, id); }) == "NOT_MEMBER");
    // Retrying against the current version succeeds.
    REQUIRE(f.conversations
                .set_members(id, {{"expected_version", 2}, {"members", {member(first), member(second)}}})
                .at("config_version") == 3);
}

TEST_CASE("removing a member revokes access but keeps the membership record", "[conversation][removal]") {
    Fixture f;
    const auto keep = f.active_session("keep");
    const auto drop = f.active_session("drop");
    const auto id = f.conversation();
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(keep), member(drop)}}});
    f.conversations.set_members(id, {{"expected_version", 2}, {"members", {member(keep)}}});

    REQUIRE(error_code([&] { f.conversations.require_member(drop, id); }) == "NOT_MEMBER");
    acm::Statement row = f.database.query(
        "SELECT removed_at FROM conversation_members WHERE conversation_id = ? AND session_id = ?", id,
        drop.session_id);
    REQUIRE(row.step());
    REQUIRE_FALSE(row.is_null(0));

    f.conversations.set_members(id, {{"expected_version", 3}, {"members", {member(keep), member(drop, true, false)}}});
    REQUIRE_NOTHROW(f.conversations.require_reader(drop, id));
    REQUIRE(error_code([&] { f.conversations.require_writer(drop, id); }) == "WRITE_DENIED");
}

TEST_CASE("member updates reject unknown, revoked and duplicated sessions", "[conversation][validation]") {
    Fixture f;
    const auto good = f.active_session("good");
    const auto gone = f.active_session("revoked later");
    f.identity.revoke_session(gone.session_id);
    const auto id = f.conversation();

    REQUIRE(error_code([&] {
                f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(gone)}}});
            }) == "SESSION_UNAVAILABLE");
    REQUIRE(error_code([&] {
                f.conversations.set_members(
                    id, {{"expected_version", 1}, {"members", {{{"session_id", "ses_missing"}}}}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] {
                f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(good), member(good)}}});
            }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.set_members(id, {{"members", json::array()}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] {
                f.conversations.set_members("cnv_missing", {{"expected_version", 1}, {"members", json::array()}});
            }) == "NOT_FOUND");
    REQUIRE(f.conversations.get(id).at("config_version") == 1);
}

TEST_CASE("membership changes are recorded as committed events", "[conversation][events]") {
    Fixture f;
    const auto session = f.active_session("eventful");
    const auto id = f.conversation();
    const auto before = f.events.watermark();
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(session)}}});

    const json added = f.events.read_after(before, 10);
    REQUIRE(added.size() == 1);
    REQUIRE(added.at(0).at("event_type") == "conversation.members_changed");
    REQUIRE(added.at(0).at("conversation_id") == id);
    REQUIRE(added.at(0).at("project_id") == "prj_alpha");
    REQUIRE(added.at(0).at("payload").at("config_version") == 2);
    REQUIRE(added.at(0).at("payload").at("members").at(0).at("session_id") == session.session_id);
}

TEST_CASE("the operator sets an overall goal that members read", "[conversation][goal]") {
    Fixture f;
    const auto member_session = f.active_session("member");
    const auto id = f.conversation();
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {member(member_session)}}});
    REQUIRE(f.conversations.get(id).at("goal").is_null());

    const auto before = f.events.watermark();
    const json updated = f.conversations.set_goal(id, {{"goal", "Deliver a verified clean CSV by Friday."}});
    REQUIRE(updated.at("goal") == "Deliver a verified clean CSV by Friday.");
    REQUIRE_FALSE(updated.at("goal_updated_at").is_null());
    REQUIRE(f.conversations.get_for_session(member_session, id).at("goal") == updated.at("goal"));
    // The event announces the change without repeating the text.
    const json events = f.events.read_after(before, 10);
    REQUIRE(events.size() == 1);
    REQUIRE(events.at(0).at("event_type") == "conversation.goal_changed");
    REQUIRE_FALSE(events.dump().contains("Friday"));

    REQUIRE(f.conversations.set_goal(id, json::object()).at("goal").is_null());
    REQUIRE(error_code([&] { f.conversations.set_goal("cnv_missing", {{"goal", "x"}}); }) == "NOT_FOUND");
}

TEST_CASE("an agent can only propose a conversation; the operator decides", "[conversation][proposal]") {
    Fixture f;
    const auto proposer = f.active_session("proposer");
    const auto peer = f.active_session("peer");
    const auto foreign = f.active_session("other project", "prj_beta");

    const json proposal = f.conversations.propose(
        proposer, {{"task_code", "DATA-020"},
                   {"title", "Outlier review"},
                   {"goal", "Explain the July spike."},
                   {"member_session_ids", {peer.session_id}}});
    REQUIRE(proposal.at("status") == "pending");
    REQUIRE(proposal.at("conversation_id").is_null());
    REQUIRE(proposal.at("member_session_ids").size() == 2);
    // Nothing exists yet: the proposer has no new conversation to read or write.
    REQUIRE(f.conversations.list_all().empty());
    REQUIRE(f.conversations.list_for_session(proposer).empty());
    // Asking again for the same task returns the waiting proposal instead of a second one.
    const json again = f.conversations.propose(proposer, {{"task_code", "DATA-020"}, {"title", "Outlier review"}});
    REQUIRE(again.at("proposal_id") == proposal.at("proposal_id"));
    REQUIRE(again.at("already_pending") == true);
    REQUIRE(f.conversations.list_proposals().size() == 1);

    REQUIRE(error_code([&] {
                f.conversations.propose(proposer, {{"task_code", "DATA-021"},
                                                   {"title", "t"},
                                                   {"member_session_ids", {foreign.session_id}}});
            }) == "INVALID_MEMBER");
    REQUIRE(error_code([&] { f.conversations.propose(proposer, {{"title", "no code"}}); }) == "INVALID_ARGUMENT");

    const std::string proposal_id = proposal.at("proposal_id");
    const json approved = f.conversations.decide_proposal(proposal_id, true);
    REQUIRE(approved.at("status") == "approved");
    const std::string conversation_id = approved.at("conversation_id");
    const json created = f.conversations.get(conversation_id);
    REQUIRE(created.at("goal") == "Explain the July spike.");
    REQUIRE(created.at("members").size() == 2);
    REQUIRE_NOTHROW(f.conversations.require_writer(proposer, conversation_id));
    REQUIRE_NOTHROW(f.conversations.require_reader(peer, conversation_id));
    // Deciding twice changes nothing, and the task code is now taken.
    REQUIRE(f.conversations.decide_proposal(proposal_id, false).at("status") == "approved");
    REQUIRE(f.conversations.list_all().size() == 1);
    REQUIRE(error_code([&] {
                f.conversations.propose(peer, {{"task_code", "DATA-020"}, {"title", "duplicate"}});
            }) == "ALREADY_EXISTS");
    REQUIRE(f.conversations.proposals_of(proposer).at(0).at("status") == "approved");
    REQUIRE(f.conversations.proposals_of(peer).empty());

    const json rejected = f.conversations.decide_proposal(
        f.conversations.propose(peer, {{"task_code", "DATA-022"}, {"title", "not needed"}})
            .at("proposal_id")
            .get<std::string>(),
        false);
    REQUIRE(rejected.at("status") == "rejected");
    REQUIRE(f.conversations.list_all().size() == 1);
    REQUIRE(error_code([&] { f.conversations.decide_proposal("prp_missing", true); }) == "NOT_FOUND");
}

TEST_CASE("the roster lists approved sessions of the caller's own project only", "[conversation][roster]") {
    Fixture f;
    const auto me = f.active_session("me");
    const auto peer = f.active_session("peer");
    const auto gone = f.active_session("revoked");
    f.identity.revoke_session(gone.session_id);
    f.active_session("elsewhere", "prj_beta");

    const json roster = f.conversations.roster(me);
    REQUIRE(roster.size() == 2);
    int mine = 0;
    for (const auto& entry : roster) {
        REQUIRE((entry.at("session_id") == me.session_id || entry.at("session_id") == peer.session_id));
        mine += entry.at("is_you").get<bool>() ? 1 : 0;
    }
    REQUIRE(mine == 1);
}

TEST_CASE("linked sessions meet in one lobby per project", "[conversation][open-mode]") {
    Fixture f;
    const auto first = f.active_session("first");
    const auto second = f.active_session("second");
    const auto elsewhere = f.active_session("elsewhere", "prj_beta");
    REQUIRE(f.conversations.list_for_session(first).empty());

    f.conversations.join_lobby(first);
    f.conversations.join_lobby(second);
    f.conversations.join_lobby(elsewhere);
    const json mine = f.conversations.list_for_session(first);
    REQUIRE(mine.size() == 1);
    REQUIRE(mine.at(0).at("kind") == "lobby");
    REQUIRE(mine.at(0).at("task_code") == "@lobby");
    const std::string lobby = mine.at(0).at("conversation_id");
    REQUIRE(f.conversations.list_for_session(second).at(0).at("conversation_id") == lobby);
    REQUIRE(f.conversations.require_writer(second, lobby).can_read);
    // Another project has its own lobby; nothing crosses over.
    REQUIRE(f.conversations.list_for_session(elsewhere).at(0).at("conversation_id") != lobby);
    REQUIRE(error_code([&] { f.conversations.require_member(elsewhere, lobby); }) == "NOT_MEMBER");

    // Joining again is free: no new version, no new event.
    const auto version = f.conversations.get(lobby).at("config_version");
    const auto count = f.events.watermark();
    f.conversations.join_lobby(first);
    REQUIRE(f.conversations.get(lobby).at("config_version") == version);
    REQUIRE(f.events.watermark() == count);

    // A member the operator removed by hand is not pulled back in.
    f.conversations.set_members(lobby, {{"expected_version", version}, {"members", {member(first)}}});
    f.conversations.join_lobby(second);
    REQUIRE(f.conversations.list_for_session(second).empty());
}

TEST_CASE("two linked sessions share one private direct conversation", "[conversation][open-mode]") {
    Fixture f;
    const auto first = f.active_session("first");
    const auto second = f.active_session("second");
    const auto third = f.active_session("third");
    const auto elsewhere = f.active_session("elsewhere", "prj_beta");

    const json opened = f.conversations.direct(first, second.session_id);
    REQUIRE(opened.at("kind") == "direct");
    REQUIRE(opened.at("members").size() == 2);
    // Either side reaches the same conversation.
    const std::string direct = opened.at("conversation_id");
    REQUIRE(f.conversations.direct(second, first.session_id).at("conversation_id") == direct);
    REQUIRE(f.conversations.get(direct).at("config_version") == opened.at("config_version"));
    REQUIRE(f.conversations.direct(first, third.session_id).at("conversation_id") != direct);

    const json listed = f.conversations.list_for_session(first);
    REQUIRE(listed.size() == 2);
    for (const auto& entry : listed) {
        const std::string expected = entry.at("conversation_id") == direct ? "second" : "third";
        REQUIRE(entry.at("with").size() == 1);
        REQUIRE(entry.at("with").at(0).at("label") == expected);
    }
    REQUIRE(error_code([&] { f.conversations.require_member(third, direct); }) == "NOT_MEMBER");

    REQUIRE(error_code([&] { f.conversations.direct(first, first.session_id); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.direct(first, elsewhere.session_id); }) == "INVALID_RECIPIENT");
    REQUIRE(error_code([&] { f.conversations.direct(first, "ses_missing"); }) == "INVALID_RECIPIENT");
    const auto revoked = f.active_session("revoked");
    f.identity.revoke_session(revoked.session_id);
    REQUIRE(error_code([&] { f.conversations.direct(first, revoked.session_id); }) == "INVALID_RECIPIENT");

    // With interconnection off the existing pair keeps talking; a new pair cannot start.
    acm::set_open_mode(f.database, false);
    REQUIRE(f.conversations.direct(first, second.session_id).at("conversation_id") == direct);
    REQUIRE(error_code([&] { f.conversations.direct(second, third.session_id); }) == "OPEN_MODE_OFF");
}

TEST_CASE("unlinking a session takes it out of the lobby and direct conversations only", "[conversation][open-mode]") {
    Fixture f;
    const auto first = f.active_session("first");
    const auto second = f.active_session("second");
    const std::string topic = f.conversation();
    f.conversations.set_members(topic, {{"expected_version", 1}, {"members", {member(first), member(second)}}});
    f.conversations.join_lobby(first);
    f.conversations.join_lobby(second);
    const std::string direct = f.conversations.direct(first, second.session_id).at("conversation_id");
    REQUIRE(f.conversations.list_for_session(second).size() == 3);

    f.identity.set_linked(second.session_id, false);
    f.conversations.apply_link(second.session_id, false);
    const auto unlinked = f.reload(second);
    // The operator-assigned topic conversation is untouched.
    const json left = f.conversations.list_for_session(unlinked);
    REQUIRE(left.size() == 1);
    REQUIRE(left.at(0).at("conversation_id") == topic);
    f.conversations.join_lobby(unlinked);
    REQUIRE(f.conversations.list_for_session(unlinked).size() == 1);
    REQUIRE(error_code([&] { f.conversations.direct(unlinked, first.session_id); }) == "NOT_LINKED");
    REQUIRE(error_code([&] { f.conversations.direct(first, second.session_id); }) == "NOT_LINKED");
    for (const auto& entry : f.conversations.roster(first)) {
        REQUIRE(entry.at("linked") == (entry.at("session_id") != second.session_id));
    }

    // Linking again restores the lobby; a direct conversation resumes when either side writes.
    f.identity.set_linked(second.session_id, true);
    f.conversations.apply_link(second.session_id, true);
    const auto relinked = f.reload(second);
    REQUIRE(f.conversations.list_for_session(relinked).size() == 2);
    REQUIRE(f.conversations.direct(first, second.session_id).at("conversation_id") == direct);
    REQUIRE(f.conversations.list_for_session(relinked).size() == 3);
    // Repeating the switch does not touch membership again.
    const auto version = f.conversations.get(direct).at("config_version");
    f.conversations.apply_link(second.session_id, true);
    REQUIRE(f.conversations.get(direct).at("config_version") == version);
}

TEST_CASE("a membership the operator ended is never restored behind the operator's back", "[conversation][open-mode]") {
    Fixture f;
    const auto first = f.active_session("first");
    auto second = f.active_session("second");
    const auto third = f.active_session("third");
    for (const auto& session : {first, second, third}) {
        f.conversations.join_lobby(session);
    }
    const json opened = f.conversations.direct(first, second.session_id);
    const std::string direct = opened.at("conversation_id");
    const auto version = [&](const std::string& id) { return f.conversations.get(id).at("config_version").get<std::int64_t>(); };

    // Nobody but the two sessions can be put into a direct conversation.
    REQUIRE(error_code([&] {
                f.conversations.set_members(
                    direct, {{"expected_version", version(direct)}, {"members", {member(first), member(second), member(third)}}});
            }) == "DIRECT_MEMBERS_FIXED");
    REQUIRE(error_code([&] { f.conversations.require_member(third, direct); }) == "NOT_MEMBER");

    // The operator removes one side: writing to the peer does not let it back in.
    f.conversations.set_members(direct, {{"expected_version", version(direct)}, {"members", {member(first)}}});
    REQUIRE(error_code([&] { f.conversations.direct(first, second.session_id); }) == "DIRECT_CLOSED");
    REQUIRE(error_code([&] { f.conversations.direct(second, first.session_id); }) == "DIRECT_CLOSED");
    REQUIRE(error_code([&] { f.conversations.require_member(second, direct); }) == "NOT_MEMBER");
    const json closed = f.conversations.get(direct);
    REQUIRE(closed.at("former_members").size() == 1);
    REQUIRE(closed.at("former_members").at(0).at("session_id") == second.session_id);
    REQUIRE(closed.at("former_members").at(0).at("removed_reason") == "operator");
    // Neither does switching the link off and on again.
    f.identity.set_linked(second.session_id, false);
    f.conversations.apply_link(second.session_id, false);
    f.identity.set_linked(second.session_id, true);
    f.conversations.apply_link(second.session_id, true);
    second = f.reload(second);
    REQUIRE(error_code([&] { f.conversations.direct(first, second.session_id); }) == "DIRECT_CLOSED");
    // Only the operator restores it.
    f.conversations.set_members(direct, {{"expected_version", version(direct)}, {"members", {member(first), member(second)}}});
    REQUIRE(f.conversations.direct(second, first.session_id).at("conversation_id") == direct);
    REQUIRE(f.conversations.get(direct).at("former_members").empty());

    // The lobby follows the same rule: removed by hand stays removed.
    const std::string lobby = f.conversations.list_for_session(first).at(0).at("kind") == "lobby"
                                  ? f.conversations.list_for_session(first).at(0).at("conversation_id").get<std::string>()
                                  : f.conversations.list_for_session(first).at(1).at("conversation_id").get<std::string>();
    f.conversations.set_members(lobby, {{"expected_version", version(lobby)}, {"members", {member(first), member(third)}}});
    f.identity.set_linked(second.session_id, false);
    f.conversations.apply_link(second.session_id, false);
    f.identity.set_linked(second.session_id, true);
    f.conversations.apply_link(second.session_id, true);
    f.conversations.join_lobby(f.reload(second));
    REQUIRE(error_code([&] { f.conversations.require_member(second, lobby); }) == "NOT_MEMBER");
}

TEST_CASE("a member list loaded before a session was unlinked cannot be saved back", "[conversation][open-mode]") {
    Fixture f;
    const auto first = f.active_session("first");
    const auto second = f.active_session("second");
    f.conversations.join_lobby(first);
    f.conversations.join_lobby(second);
    const std::string lobby = f.conversations.list_for_session(first).at(0).at("conversation_id");
    const std::string direct = f.conversations.direct(first, second.session_id).at("conversation_id");
    // What an operator page shows before the switch.
    const std::int64_t stale_lobby = f.conversations.get(lobby).at("config_version");
    const std::int64_t stale_direct = f.conversations.get(direct).at("config_version");
    const json both = {member(first), member(second)};

    f.identity.set_linked(second.session_id, false);
    f.conversations.apply_link(second.session_id, false);

    REQUIRE(error_code([&] { f.conversations.set_members(lobby, {{"expected_version", stale_lobby}, {"members", both}}); }) ==
            "VERSION_CONFLICT");
    REQUIRE(error_code([&] { f.conversations.set_members(direct, {{"expected_version", stale_direct}, {"members", both}}); }) ==
            "VERSION_CONFLICT");
    // Even with the current version an unlinked session cannot be put back.
    for (const auto& id : {lobby, direct}) {
        const std::int64_t current = f.conversations.get(id).at("config_version");
        REQUIRE(error_code([&] { f.conversations.set_members(id, {{"expected_version", current}, {"members", both}}); }) ==
                "NOT_LINKED");
        REQUIRE(error_code([&] { f.conversations.require_member(f.reload(second), id); }) == "NOT_MEMBER");
    }
    REQUIRE(f.conversations.get(direct).at("former_members").at(0).at("removed_reason") == "unlinked");
    // A task conversation is the operator's own list and stays open to that session.
    const std::string topic = f.conversation();
    REQUIRE_NOTHROW(f.conversations.set_members(topic, {{"expected_version", 1}, {"members", both}}));
}

TEST_CASE("a task conversation may be called LOBBY and reserved codes are refused", "[conversation][open-mode]") {
    Fixture f;
    const std::string topic = f.conversation("LOBBY");
    const auto first = f.active_session("first");
    // The lobby is still created, next to the task conversation of that name.
    REQUIRE_NOTHROW(f.conversations.join_lobby(first));
    const json mine = f.conversations.list_for_session(first);
    REQUIRE(mine.size() == 1);
    REQUIRE(mine.at(0).at("kind") == "lobby");
    REQUIRE(mine.at(0).at("conversation_id") != topic);
    REQUIRE(f.conversations.get(topic).at("kind") == "topic");

    REQUIRE(error_code([&] { f.conversation("@lobby"); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversation("@dm-0123456789abcdef"); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.propose(first, {{"task_code", "@lobby"}, {"title", "x"}}); }) ==
            "INVALID_ARGUMENT");
    REQUIRE(f.conversations.list_all().size() == 2);
}

// ---- keeping the list tidy: rename, archive, clear, delete ------------------

namespace {

// The whole of what hangs on a conversation: messages, receipts, progress, tasks
// and what the client hooks remember about them.
struct Tidy {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    acm::Conversations conversations{database, events, time.clock()};
    acm::Messages messages{database, events, conversations, time.clock()};
    acm::Board board{database, events, conversations, time.clock()};
    acm::Progress progress{database, conversations, messages, time.clock()};
    acm::Delivery delivery{database, events, time.clock()};
    acm::Session claude = join("claude");
    acm::Session codex = join("codex");
    std::string lobby = of_kind(claude, "lobby");
    std::string topic = make_topic("DATA-1", "Clean the readings");
    int next_key = 0;

    acm::Session join(const std::string& client) {
        const std::string token = "acm_" + acm::random_hex(24);
        identity.enroll(token, {{"client", client}});
        conversations.join_lobby(identity.authenticate(token));
        return identity.authenticate(token);
    }
    std::string of_kind(const acm::Session& session, const std::string& kind) {
        for (const auto& entry : conversations.list_for_session(session)) {
            if (entry.at("kind") == kind) {
                return entry.at("conversation_id");
            }
        }
        return {};
    }
    std::string make_topic(const std::string& code, const std::string& title) {
        const std::string id =
            conversations.create_conversation({{"project_id", "prj_default"}, {"task_code", code}, {"title", title}})
                .at("conversation_id");
        conversations.set_members(id, {{"expected_version", 1},
                                       {"members",
                                        {{{"session_id", claude.session_id}, {"can_read", true}, {"can_write", true}},
                                         {{"session_id", codex.session_id}, {"can_read", true}, {"can_write", true}}}}});
        return id;
    }
    json say(const acm::Session& from, const std::string& where, const std::string& body, json extra = json::object()) {
        extra["conversation_id"] = where;
        extra["body"] = body;
        extra["idempotency_key"] = "k-" + std::to_string(++next_key);
        return messages.send(from, extra);
    }
    std::int64_t count(const std::string& sql) {
        acm::Statement row = database.query(sql);
        row.step();
        return row.integer(0);
    }
    bool listed(const acm::Session& session, const std::string& id) {
        const json mine = conversations.list_for_session(session);
        return std::ranges::any_of(mine, [&](const json& entry) { return entry.at("conversation_id") == id; });
    }
};

}  // namespace

TEST_CASE("the operator renames a task conversation and nothing else", "[conversation][tidy]") {
    Tidy f;
    const json renamed = f.conversations.update(f.topic, {{"title", "Clean July"}, {"task_code", "DATA-7"}, {"purpose", "all of July"}});
    REQUIRE(renamed.at("title") == "Clean July");
    REQUIRE(renamed.at("task_code") == "DATA-7");
    REQUIRE(renamed.at("purpose") == "all of July");
    REQUIRE(f.conversations.update(f.topic, {{"purpose", ""}}).at("purpose").is_null());
    // The same values again change nothing and say nothing.
    const auto before = f.events.watermark();
    f.conversations.update(f.topic, {{"title", "Clean July"}});
    REQUIRE(f.events.watermark() == before);

    const std::string other = f.make_topic("DATA-8", "Other");
    REQUIRE(error_code([&] { f.conversations.update(other, {{"task_code", "DATA-7"}}); }) == "ALREADY_EXISTS");
    REQUIRE(error_code([&] { f.conversations.update(other, {{"task_code", "@lobby"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.update(other, {{"title", ""}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.update(other, json::object()); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.update(other, {{"archived", "yes"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { f.conversations.update("cnv_missing", {{"title", "x"}}); }) == "NOT_FOUND");
    // The lobby and direct conversations are named by the service.
    REQUIRE(error_code([&] { f.conversations.update(f.lobby, {{"title", "Hall"}}); }) == "INVALID_ARGUMENT");
    const std::string direct = f.conversations.direct(f.claude, f.codex.session_id).at("conversation_id");
    REQUIRE(error_code([&] { f.conversations.update(direct, {{"task_code", "X-1"}}); }) == "INVALID_ARGUMENT");
    REQUIRE_NOTHROW(f.conversations.update(direct, {{"purpose", "pairing on the review"}}));
}

TEST_CASE("an archived conversation is put away, not deleted", "[conversation][tidy]") {
    Tidy f;
    f.say(f.codex, f.topic, "first finding");
    f.say(f.codex, f.topic, "needs an answer now", {{"urgent", true}});
    REQUIRE(f.conversations.get(f.topic).at("message_count") == 2);
    REQUIRE(f.conversations.get(f.topic).at("last_message_at").is_string());

    const json archived = f.conversations.update(f.topic, {{"archived", true}});
    REQUIRE(archived.at("status") == "archived");
    // Sessions no longer see it, cannot read or write it, and nothing in it waits for them.
    REQUIRE_FALSE(f.listed(f.claude, f.topic));
    REQUIRE(error_code([&] { f.conversations.require_reader(f.claude, f.topic); }) == "CONVERSATION_ARCHIVED");
    REQUIRE(error_code([&] { f.say(f.claude, f.topic, "too late"); }) == "CONVERSATION_ARCHIVED");
    REQUIRE(error_code([&] { f.messages.send_as_operator({{"conversation_id", f.topic}, {"body", "x"}}); }) ==
            "CONVERSATION_ARCHIVED");
    REQUIRE(f.messages.pending_count(f.claude) == 0);
    REQUIRE(f.delivery.hook(f.claude, {{"event", "prompt"}, {"client", "claude"}}).at("count") == 0);
    // The operator still sees it, with everything in it.
    REQUIRE(f.conversations.list_all().size() == 2);
    REQUIRE(f.messages.read_all(f.topic, json::object()).at("messages").size() == 2);

    // Restored, it is as it was: the two messages are still unread for Claude.
    REQUIRE(f.conversations.update(f.topic, {{"archived", false}}).at("status") == "open");
    REQUIRE(acm_test::event_types(f.events).back() == "conversation.restored");
    REQUIRE(f.listed(f.claude, f.topic));
    REQUIRE(f.messages.unread(f.claude, f.topic, 30).at("messages").size() == 2);

    // The lobby stays; a direct conversation comes back when one of the two writes again.
    REQUIRE(error_code([&] { f.conversations.update(f.lobby, {{"archived", true}}); }) == "INVALID_ARGUMENT");
    const std::string direct = f.conversations.direct(f.claude, f.codex.session_id).at("conversation_id");
    f.conversations.update(direct, {{"archived", true}});
    REQUIRE_FALSE(f.listed(f.codex, direct));
    const json reopened = f.conversations.direct(f.codex, f.claude.session_id);
    REQUIRE(reopened.at("conversation_id") == direct);
    REQUIRE(reopened.at("status") == "open");
}

TEST_CASE("clearing deletes messages and what hangs on them, and nothing else", "[conversation][tidy]") {
    Tidy f;
    const std::string old_id = f.say(f.codex, f.lobby, "old note").at("message_id");
    f.progress.report_progress(f.codex, {{"conversation_id", f.lobby}, {"stage", "check"}, {"run_state", "running"}, {"summary", "old progress"}, {"idempotency_key", "p-1"}});
    f.time.advance(std::chrono::hours(24 * 10));
    const std::string reply_id = f.say(f.claude, f.lobby, "answer to the old note", {{"reply_to_message_id", old_id}}).at("message_id");
    // A copy of the old note lives on in the task conversation.
    const std::string copy_id = f.messages.forward(f.claude, {{"message_id", old_id}, {"to_conversation_id", f.topic}, {"idempotency_key", "f-1"}}).at("message_id");
    f.delivery.hook(f.codex, {{"event", "prompt"}, {"client", "codex"}});

    // Only what is older than a week goes.
    const json cleared = f.conversations.clear_messages(f.lobby, {{"older_than_days", 7}});
    REQUIRE(cleared.at("deleted_messages") == 2);
    REQUIRE(cleared.at("message_count") == 1);
    REQUIRE(f.count("SELECT COUNT(*) FROM progress_events") == 0);
    REQUIRE(f.count("SELECT COUNT(*) FROM message_recipients r LEFT JOIN messages m ON m.message_id = r.message_id WHERE m.message_id IS NULL") == 0);
    // What stayed no longer points at what went.
    const json page = f.messages.read_all(f.lobby, json::object());
    REQUIRE(page.at("messages").size() == 1);
    REQUIRE(page.at("messages").at(0).at("message_id") == reply_id);
    REQUIRE(page.at("messages").at(0).at("reply_to_message_id").is_null());
    const json copy = f.messages.read_all(f.topic, json::object()).at("messages").at(0);
    REQUIRE(copy.at("message_id") == copy_id);
    REQUIRE(copy.at("forwarded_from").is_null());
    REQUIRE(copy.at("body") == "old note");
    // The event says how many went, not what they said.
    const json events = f.events.read_after(0, 1000);
    REQUIRE(events.back().at("event_type") == "conversation.cleared");
    REQUIRE_FALSE(events.back().dump().contains("old note"));

    // Everything: the conversation stays, empty, and numbering goes on where it was.
    REQUIRE(f.conversations.clear_messages(f.lobby, json::object()).at("deleted_messages") == 1);
    REQUIRE(f.conversations.clear_messages(f.lobby, json::object()).at("deleted_messages") == 0);
    REQUIRE(f.count("SELECT COUNT(*) FROM messages") == 1);  // the forwarded copy elsewhere
    const json next = f.say(f.claude, f.lobby, "fresh start");
    REQUIRE(next.at("sequence") == 4);
    // A hook that had seen the deleted messages still shows the new one.
    const json shown = f.delivery.hook(f.codex, {{"event", "prompt"}, {"client", "codex"}});
    REQUIRE(shown.at("count") == 1);
    REQUIRE(shown.at("text").get<std::string>().contains("fresh start"));
    REQUIRE(f.messages.unread(f.codex, f.lobby, 30).at("messages").size() == 1);
    REQUIRE(error_code([&] { f.conversations.clear_messages("cnv_missing", json::object()); }) == "NOT_FOUND");
}

TEST_CASE("deleting a conversation removes it with everything in it", "[conversation][tidy]") {
    Tidy f;
    f.say(f.codex, f.topic, "confidential plan", {{"recipient_session_ids", json::array({f.claude.session_id})}});
    f.progress.report_progress(f.claude, {{"conversation_id", f.topic}, {"stage", "s"}, {"run_state", "completed"}, {"summary", "done"}, {"idempotency_key", "p-2"}});
    f.board.create_task(f.claude, {{"conversation_id", f.topic}, {"title", "follow up"}});
    f.say(f.codex, f.lobby, "stays");

    const json gone = f.conversations.remove(f.topic);
    REQUIRE(gone.at("deleted") == true);
    REQUIRE(gone.at("deleted_messages") == 2);
    REQUIRE(gone.at("deleted_tasks") == 1);
    REQUIRE(error_code([&] { f.conversations.get(f.topic); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.conversations.remove(f.topic); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.conversations.require_member(f.claude, f.topic); }) == "NOT_MEMBER");
    for (const char* table : {"messages", "conversation_members", "tasks", "progress_events"}) {
        REQUIRE(f.count(std::string("SELECT COUNT(*) FROM ") + table + " WHERE conversation_id = '" + f.topic + "'") == 0);
    }
    // The rest is untouched, and the record of the deletion carries no content.
    REQUIRE(f.messages.read_all(f.lobby, json::object()).at("messages").size() == 1);
    const json events = f.events.read_after(0, 1000);
    REQUIRE(events.back().at("event_type") == "conversation.deleted");
    REQUIRE(events.back().at("payload").at("title") == "Clean the readings");
    REQUIRE_FALSE(events.back().dump().contains("confidential"));
    // Its task code is free again.
    REQUIRE_NOTHROW(f.make_topic("DATA-1", "Second attempt"));

    // The lobby is needed by everyone. A deleted direct conversation starts afresh on the next message.
    REQUIRE(error_code([&] { f.conversations.remove(f.lobby); }) == "INVALID_ARGUMENT");
    const std::string direct = f.conversations.direct(f.claude, f.codex.session_id).at("conversation_id");
    f.say(f.claude, direct, "between us");
    f.conversations.remove(direct);
    const json fresh = f.conversations.direct(f.codex, f.claude.session_id);
    REQUIRE(fresh.at("conversation_id") != direct);
    REQUIRE(fresh.at("message_count") == 0);
}
