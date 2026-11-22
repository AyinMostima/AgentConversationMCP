// Identity and pairing: logical agents, and the concrete session instances
// that are bound to them through an operator-approved pairing.
//
// Lifecycle of a session credential:
//   pending    operator created the pairing; the token is shown once
//   requested  the real client connected and reported which instance it is
//   active     operator approved that instance; conversation tools unlock
//   revoked    operator withdrew the credential; history is kept
//   expired    nobody completed the pairing before its deadline
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"

namespace acm {

// The authenticated caller of an agent command. Always derived from the
// presented credential, never from command arguments.
struct Session {
    std::string session_id;
    std::string agent_id;
    std::string project_id;
    std::string label;
    std::string status;
    std::int64_t binding_version = 0;
    // Takes part in the default interconnection (lobby and direct conversations).
    bool linked = true;
    // Not subject to the per-session flood limits.
    bool rate_exempt = false;
};

class Identity {
public:
    Identity(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // Operator: register a logical agent {agent_id?, provider, client_kind, display_name}.
    json create_agent(const json& args);
    // Operator: {display_name}. How an agent is called everywhere it is shown.
    json update_agent(std::string_view agent_id, const json& args);

    // Operator: open a pairing {agent_id, project_id, label, ttl_seconds?}. The
    // returned `token` is the only time the plaintext credential is available.
    json create_pairing(const json& args);

    // Resolves a bearer token. Unknown tokens fail UNAUTHENTICATED and revoked
    // ones fail SESSION_REVOKED; an overdue pairing is moved to `expired`.
    Session authenticate(std::string_view token);

    // Agent: report the connecting instance {client_kind, cwd?, run_id?, external_session_id?}.
    json request_pairing(const Session& session, const json& args);

    // Self-enrollment, for a bridge that was installed without an operator-issued
    // credential. The bridge generates its own credential, keeps it, and presents
    // it here together with {client, label?, project_id?, cwd?, run_id?}.
    //   unknown credential  a session is registered for it (the agent for that
    //                       client and the default project are created on demand)
    //   known credential    its pairing is brought up to date; safe to repeat
    // The session becomes `active` at once while default interconnection is on,
    // and `requested` (waiting for the operator) while it is off. A revoked
    // credential stays revoked.
    json enroll(std::string_view token, const json& args);

    // Operator: approve the instance that requested this pairing.
    json approve_pairing(std::string_view session_id);

    // Operator: withdraw a credential in any state; idempotent.
    json revoke_session(std::string_view session_id);

    // Operator: include a session in, or take it out of, the default interconnection.
    json set_linked(std::string_view session_id, bool linked);

    // Operator: lift or restore the flood limits for one session.
    json set_rate_exempt(std::string_view session_id, bool exempt);
    // Operator: whether an urgent message may start a turn in this session's client while it is idle.
    json set_urgent_dispatch(std::string_view session_id, bool enabled);

    // Gate for conversation tools: fails NOT_PAIRED or PAIRING_EXPIRED.
    void require_active(const Session& session) const;

    // Session, agent and binding state for the caller's own credential.
    json describe(const Session& session);

    // Operator: every session with its pairing evidence, newest first.
    json list_sessions();

    // Operator: every logical agent, oldest first.
    json list_agents();

    // Moves overdue pending/requested pairings to `expired`; returns how many.
    std::int64_t expire_stale_pairings();

private:
    json session_row(std::string_view session_id);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
