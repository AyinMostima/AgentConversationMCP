// Tests for src/core/identity: logical agents, pairing lifecycle, credential
// handling, revocation and expiry.
#include "core/identity.hpp"
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

    Fixture() {
        acm_test::insert_project(database, "prj_alpha");
        identity.create_agent({{"agent_id", "agt_codex"},
                               {"provider", "openai"},
                               {"client_kind", "codex-desktop"},
                               {"display_name", "Codex"}});
    }

    json pair(const std::string& label, std::int64_t ttl_seconds = 900) {
        return identity.create_pairing(
            {{"agent_id", "agt_codex"}, {"project_id", "prj_alpha"}, {"label", label}, {"ttl_seconds", ttl_seconds}});
    }
};

}  // namespace

TEST_CASE("pairing moves pending -> requested -> active and unlocks the session", "[identity][pairing]") {
    Fixture f;
    acm::set_open_mode(f.database, false);
    const json pairing = f.pair("codex window 1");
    const std::string token = pairing.at("token");
    REQUIRE(pairing.at("status") == "pending");
    REQUIRE(token.starts_with("acm_"));

    acm::Session session = f.identity.authenticate(token);
    REQUIRE(session.session_id == pairing.at("session_id").get<std::string>());
    REQUIRE(session.agent_id == "agt_codex");
    REQUIRE(session.project_id == "prj_alpha");
    REQUIRE(error_code([&] { f.identity.require_active(session); }) == "NOT_PAIRED");

    const json requested = f.identity.request_pairing(
        session, {{"client_kind", "codex-desktop"}, {"cwd", "F:\\work"}, {"run_id", "pid-4242"}});
    REQUIRE(requested.at("status") == "requested");
    REQUIRE(requested.at("claimed_cwd") == "F:\\work");
    REQUIRE(requested.at("claimed_run_id") == "pid-4242");
    REQUIRE(requested.at("external_session_id").is_null());
    REQUIRE(error_code([&] { f.identity.require_active(f.identity.authenticate(token)); }) == "NOT_PAIRED");

    const json approved = f.identity.approve_pairing(session.session_id);
    REQUIRE(approved.at("status") == "active");
    REQUIRE_FALSE(approved.at("approved_at").is_null());

    session = f.identity.authenticate(token);
    REQUIRE(session.status == "active");
    REQUIRE_NOTHROW(f.identity.require_active(session));

    const json view = f.identity.describe(session);
    REQUIRE(view.at("agent").at("provider") == "openai");
    REQUIRE(view.at("capabilities").at("shared_read_write") == true);
    REQUIRE(view.at("capabilities").at("steer_active") == false);
    REQUIRE_FALSE(view.contains("token"));

    REQUIRE(acm_test::event_types(f.events) ==
            std::vector<std::string>{"agent.created", "pairing.created", "pairing.requested", "pairing.approved"});
}

TEST_CASE("with default interconnection a reported instance is approved at once", "[identity][open-mode]") {
    Fixture f;
    REQUIRE(acm::open_mode(f.database));
    const json pairing = f.pair("codex window 1");
    const std::string token = pairing.at("token");
    REQUIRE(pairing.at("status") == "pending");
    REQUIRE(pairing.at("linked") == true);
    // The credential alone unlocks nothing: the instance still has to report itself.
    REQUIRE(error_code([&] { f.identity.require_active(f.identity.authenticate(token)); }) == "NOT_PAIRED");

    const json joined = f.identity.request_pairing(f.identity.authenticate(token), {{"client_kind", "codex-desktop"}});
    REQUIRE(joined.at("status") == "active");
    REQUIRE(joined.at("approved_at") == joined.at("requested_at"));
    REQUIRE_NOTHROW(f.identity.require_active(f.identity.authenticate(token)));

    const json events = f.events.read_after(0, 100);
    REQUIRE(events.back().at("event_type") == "pairing.approved");
    REQUIRE(events.back().at("payload").at("automatic") == true);

    // Switching it off restores the approval step for later pairings only.
    acm::set_open_mode(f.database, false);
    const std::string later = f.pair("codex window 2").at("token");
    REQUIRE(f.identity.request_pairing(f.identity.authenticate(later), {{"client_kind", "codex-desktop"}})
                .at("status") == "requested");
    REQUIRE(f.identity.authenticate(token).status == "active");
}

TEST_CASE("the operator takes a session out of the interconnection and puts it back", "[identity][open-mode]") {
    Fixture f;
    const json pairing = f.pair("codex window 1");
    const std::string token = pairing.at("token");
    const std::string session_id = pairing.at("session_id");
    REQUIRE(f.identity.authenticate(token).linked);

    REQUIRE(f.identity.set_linked(session_id, false).at("linked") == false);
    REQUIRE_FALSE(f.identity.authenticate(token).linked);
    const auto count = f.events.watermark();
    // Repeating the same value changes nothing and records nothing.
    f.identity.set_linked(session_id, false);
    REQUIRE(f.events.watermark() == count);

    REQUIRE(f.identity.set_linked(session_id, true).at("linked") == true);
    REQUIRE(f.identity.authenticate(token).linked);
    REQUIRE(f.events.read_after(count, 10).at(0).at("event_type") == "session.link_changed");
    REQUIRE(error_code([&] { f.identity.set_linked("ses_missing", false); }) == "NOT_FOUND");
}

TEST_CASE("approval requires the client instance to have reported itself", "[identity][pairing]") {
    Fixture f;
    const json pairing = f.pair("never connected");
    REQUIRE(error_code([&] { f.identity.approve_pairing(pairing.at("session_id").get<std::string>()); }) ==
            "PAIRING_NOT_REQUESTED");
    REQUIRE(error_code([&] { f.identity.approve_pairing("ses_missing"); }) == "NOT_FOUND");
}

TEST_CASE("credentials are stored hashed and unknown tokens are rejected", "[identity][credential]") {
    Fixture f;
    const std::string token = f.pair("hash check").at("token");
    acm::Statement row = f.database.query("SELECT token_hash FROM agent_sessions");
    REQUIRE(row.step());
    REQUIRE(row.text(0) == acm::sha256_hex(token));
    REQUIRE(row.text(0) != token);
    REQUIRE(error_code([&] { f.identity.authenticate("acm_not-a-real-token"); }) == "UNAUTHENTICATED");
    REQUIRE(error_code([&] { f.identity.authenticate(""); }) == "UNAUTHENTICATED");
    for (const auto& listed : f.identity.list_sessions()) {
        REQUIRE_FALSE(listed.dump().contains(token));
    }
}

TEST_CASE("two sessions of the same agent are distinct instances", "[identity][sessions]") {
    Fixture f;
    const json first = f.pair("codex window 1");
    const json second = f.pair("codex window 2");
    REQUIRE(first.at("session_id") != second.at("session_id"));
    REQUIRE(first.at("token") != second.at("token"));
    REQUIRE(f.identity.authenticate(first.at("token").get<std::string>()).session_id == first.at("session_id").get<std::string>());
    REQUIRE(f.identity.authenticate(second.at("token").get<std::string>()).session_id == second.at("session_id").get<std::string>());
    REQUIRE(f.identity.list_sessions().size() == 2);
}

TEST_CASE("revocation blocks the credential, bumps the binding version and is idempotent", "[identity][revoke]") {
    Fixture f;
    const json pairing = f.pair("to revoke");
    const std::string token = pairing.at("token");
    const std::string session_id = pairing.at("session_id");
    f.identity.request_pairing(f.identity.authenticate(token), {{"client_kind", "codex-desktop"}});
    f.identity.approve_pairing(session_id);

    const json revoked = f.identity.revoke_session(session_id);
    REQUIRE(revoked.at("status") == "revoked");
    REQUIRE(revoked.at("binding_version") == 2);
    REQUIRE(error_code([&] { f.identity.authenticate(token); }) == "SESSION_REVOKED");
    REQUIRE(error_code([&] { f.identity.approve_pairing(session_id); }) == "PAIRING_CLOSED");

    const json again = f.identity.revoke_session(session_id);
    REQUIRE(again.at("binding_version") == 2);
    REQUIRE(again.at("revoked_at") == revoked.at("revoked_at"));
}

TEST_CASE("an overdue pairing expires and stays expired", "[identity][expiry]") {
    Fixture f;
    acm::set_open_mode(f.database, false);
    const json unanswered = f.pair("unanswered", 60);
    const json requested = f.pair("requested late", 60);
    const std::string requested_token = requested.at("token");
    f.identity.request_pairing(f.identity.authenticate(requested_token), {{"client_kind", "codex-desktop"}});

    f.time.advance(std::chrono::seconds(61));

    acm::Session late = f.identity.authenticate(unanswered.at("token").get<std::string>());
    REQUIRE(late.status == "expired");
    REQUIRE(error_code([&] { f.identity.require_active(late); }) == "PAIRING_EXPIRED");
    REQUIRE(error_code([&] { f.identity.request_pairing(late, {{"client_kind", "codex-desktop"}}); }) ==
            "PAIRING_EXPIRED");

    const std::string requested_id = requested.at("session_id");
    REQUIRE(error_code([&] { f.identity.approve_pairing(requested_id); }) == "PAIRING_EXPIRED");
    // The expiry committed even though the approval call failed.
    REQUIRE(f.identity.authenticate(requested_token).status == "expired");
    REQUIRE(f.identity.expire_stale_pairings() == 0);
}

TEST_CASE("startup sweep expires every overdue pairing but leaves active sessions", "[identity][expiry]") {
    Fixture f;
    const json active = f.pair("active", 60);
    f.identity.request_pairing(f.identity.authenticate(active.at("token").get<std::string>()),
                               {{"client_kind", "codex-desktop"}});
    f.identity.approve_pairing(active.at("session_id").get<std::string>());
    f.pair("stale one", 60);
    f.pair("stale two", 60);

    f.time.advance(std::chrono::seconds(3600));
    REQUIRE(f.identity.expire_stale_pairings() == 2);
    REQUIRE(f.identity.authenticate(active.at("token").get<std::string>()).status == "active");
}

TEST_CASE("invalid and conflicting operator input is rejected with stable codes", "[identity][validation]") {
    Fixture f;
    REQUIRE(error_code([&] {
                f.identity.create_agent({{"agent_id", "agt_codex"},
                                         {"provider", "openai"},
                                         {"client_kind", "codex-desktop"},
                                         {"display_name", "Duplicate"}});
            }) == "ALREADY_EXISTS");
    REQUIRE(error_code([&] { f.identity.create_agent({{"provider", "openai"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] {
                f.identity.create_pairing({{"agent_id", "agt_codex"}, {"project_id", "prj_missing"}, {"label", "x"}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] {
                f.identity.create_pairing({{"agent_id", "agt_missing"}, {"project_id", "prj_alpha"}, {"label", "x"}});
            }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.pair("bad ttl", 0); }) == "INVALID_ARGUMENT");
}

TEST_CASE("sessions survive closing and reopening the database", "[identity][persistence]") {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    std::string token;
    std::string session_id;
    {
        acm::Database database{store.path()};
        acm::EventLog events{database, time.clock()};
        acm::Identity identity{database, events, time.clock()};
        acm_test::insert_project(database, "prj_alpha");
        identity.create_agent({{"agent_id", "agt_claude"},
                               {"provider", "anthropic"},
                               {"client_kind", "claude-desktop"},
                               {"display_name", "Claude"}});
        const json pairing =
            identity.create_pairing({{"agent_id", "agt_claude"}, {"project_id", "prj_alpha"}, {"label", "persist"}});
        token = pairing.at("token");
        session_id = pairing.at("session_id");
        identity.request_pairing(identity.authenticate(token), {{"client_kind", "claude-desktop"}});
        identity.approve_pairing(session_id);
    }
    acm::Database reopened{store.path()};
    acm::EventLog events{reopened, time.clock()};
    acm::Identity identity{reopened, events, time.clock()};
    REQUIRE(reopened.schema_version() >= 1);
    const acm::Session session = identity.authenticate(token);
    REQUIRE(session.session_id == session_id);
    REQUIRE(session.status == "active");
}

TEST_CASE("a bridge enrolls the credential it generated, without an operator step", "[identity][enroll]") {
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    const std::string token = "acm_" + acm::random_hex(24);

    // Nothing exists yet: no project, no agent. The first client creates both.
    const json joined = identity.enroll(token, {{"client", "codex"}, {"cwd", "F:\\work"}, {"run_id", "pid-7"}});
    REQUIRE(joined.at("status") == "active");
    // It registered itself, and this start of the bridge said nothing about what it offers.
    REQUIRE(joined.at("self_enrolled") == true);
    REQUIRE(joined.at("bridge_tools").is_null());
    REQUIRE(joined.at("bridge_contract").is_null());
    REQUIRE(joined.at("agent_id") == "agt_codex");
    REQUIRE(joined.at("project_id") == "prj_default");
    REQUIRE(joined.at("label") == "codex-desktop");
    REQUIRE(joined.at("claimed_cwd") == "F:\\work");
    REQUIRE_FALSE(joined.dump().contains(token));
    const acm::Session session = identity.authenticate(token);
    REQUIRE(session.session_id == joined.at("session_id").get<std::string>());
    REQUIRE_NOTHROW(identity.require_active(session));
    REQUIRE(acm_test::event_types(events) ==
            std::vector<std::string>{"agent.created", "project.created", "pairing.created", "pairing.requested",
                                     "pairing.approved"});

    // Starting the bridge again changes nothing: same session, no new events.
    const auto count = events.watermark();
    REQUIRE(identity.enroll(token, {{"client", "codex"}}).at("session_id") == joined.at("session_id"));
    REQUIRE(events.watermark() == count);
    // A newer bridge says what it offers; an older one started afterwards takes the contract back.
    const json current = identity.enroll(token, {{"client", "codex"}, {"bridge_tools", 22}, {"bridge_contract", 3}});
    REQUIRE(current.at("bridge_tools") == 22);
    REQUIRE(current.at("bridge_contract") == 3);
    // A bridge that relays the service's own tool list says so, and stops saying so when replaced by one that does not.
    REQUIRE(current.at("bridge_relay") == false);
    REQUIRE(identity.enroll(token, {{"client", "codex"}, {"bridge_tools", 23}, {"bridge_contract", 3}, {"bridge_relay", true}}).at("bridge_relay") == true);
    REQUIRE(identity.enroll(token, {{"client", "codex"}, {"bridge_tools", 22}}).at("bridge_contract").is_null());
    REQUIRE(identity.list_sessions().size() == 1);

    // Another client shares the default project and gets its own agent and session.
    const std::string other = "acm_" + acm::random_hex(24);
    const json second = identity.enroll(other, {{"client", "antigravity"}, {"label", "main window"}});
    REQUIRE(second.at("agent_id") == "agt_antigravity");
    REQUIRE(second.at("project_id") == "prj_default");
    REQUIRE(second.at("label") == "main window");
    REQUIRE(second.at("session_id") != joined.at("session_id"));
    // A client that is not one of the four gets an agent named after it.
    REQUIRE(identity.enroll("acm_" + acm::random_hex(24), {{"client", "my-tool"}}).at("agent_id") == "agt_my-tool");

    REQUIRE(error_code([&] { identity.enroll("acm_short", {{"client", "codex"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { identity.enroll(token, {{"client", "Not Valid"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { identity.enroll(token, json::object()); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] {
                identity.enroll("acm_" + acm::random_hex(24), {{"client", "codex"}, {"project_id", "prj_missing"}});
            }) == "NOT_FOUND");
}

TEST_CASE("self-enrollment waits for the operator while interconnection is off", "[identity][enroll]") {
    Fixture f;
    acm::set_open_mode(f.database, false);
    const std::string token = "acm_" + acm::random_hex(24);

    const json waiting = f.identity.enroll(token, {{"client", "grok"}, {"project_id", "prj_alpha"}});
    REQUIRE(waiting.at("status") == "requested");
    REQUIRE(waiting.at("agent_id") == "agt_grok");
    REQUIRE(error_code([&] { f.identity.require_active(f.identity.authenticate(token)); }) == "NOT_PAIRED");

    // Nobody approved in time; the next start of the bridge asks again instead of staying expired.
    f.time.advance(std::chrono::seconds(16 * 60));
    REQUIRE(f.identity.authenticate(token).status == "expired");
    const json again = f.identity.enroll(token, {{"client", "grok"}});
    REQUIRE(again.at("status") == "requested");
    REQUIRE(again.at("session_id") == waiting.at("session_id"));
    REQUIRE(f.identity.approve_pairing(again.at("session_id").get<std::string>()).at("status") == "active");
    REQUIRE(f.identity.enroll(token, {{"client", "grok"}}).at("status") == "active");

    // Switching interconnection on lets a waiting enrollment in at its next start.
    const std::string late = "acm_" + acm::random_hex(24);
    REQUIRE(f.identity.enroll(late, {{"client", "claude"}, {"project_id", "prj_alpha"}}).at("status") == "requested");
    acm::set_open_mode(f.database, true);
    REQUIRE(f.identity.enroll(late, {{"client", "claude"}}).at("status") == "active");

    // What the operator revoked cannot enroll itself back in.
    f.identity.revoke_session(again.at("session_id").get<std::string>());
    REQUIRE(error_code([&] { f.identity.enroll(token, {{"client", "grok"}}); }) == "SESSION_REVOKED");
}