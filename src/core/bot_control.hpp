// Bot control: one session (the host, for example the Grok Bot main bot) lets
// the other sessions of its project operate the bots it runs. Requests are
// queued here; the host takes them when it is listening, carries them out with
// its own means and reports the outcome, which the requester receives at its
// next check-in. Nothing is pushed to the host and nothing leaves this machine.
//
// What can be asked is a closed list of actions. Removing a bot is not on it:
//   ask             an instruction for the host's main bot           {text}
//   list_bots       which bots the host runs                         {}
//   create_bot      start a new bot                                  {bot, text?}
//   send_to_bot     pass an instruction to one bot                   {bot, text}
//   get_transcript  what one bot said recently                       {bot}
// A request whose wording asks for a bot to be deleted or removed anyway is
// not delivered: it is held until the operator releases or rejects it.
//
// Lifecycle: held -> queued | rejected      (operator decision)
//            queued -> taken -> done | failed
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"

namespace acm {

class BotControl {
public:
    BotControl(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // Requester: {action, bot?, text?, host_session_id?, idempotency_key}.
    // Without host_session_id the request goes to the one session of the project
    // that serves bot requests. Unknown actions fail ACTION_NOT_ALLOWED; the
    // session-wide rate limit applies; a repeated idempotency_key returns the
    // first request.
    json request(const Session& session, const json& args);

    // Requester: its own recent requests with their state and results. {limit?}
    json list(const Session& session, const json& args);

    // Host: take queued requests addressed to this session, oldest first, and
    // see the ones it took earlier and has not answered. {limit?}
    // Calling it is what marks a session as serving bot requests.
    json pull(const Session& session, const json& args);

    // Host: report the outcome of a request it took. {request_id, ok?, result}
    json respond(const Session& session, const json& args);

    // For check-in: results that finished since the requester last looked (each
    // is handed out once), and how many requests wait for the caller as host.
    json news(const Session& session);

    // Operator: held requests first, then the most recent others.
    json admin_list();

    // Operator: release a held request to the host, or reject it. Idempotent.
    json decide(std::string_view request_id, bool approve);

private:
    json row(std::string_view request_id);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
