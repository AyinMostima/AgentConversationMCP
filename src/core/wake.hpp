// Wake hooks: a way to tell a session that cannot be reached from here that
// work is waiting for it, through an entry point its own vendor provides (for
// Grok Bot: a routine with a webhook trigger).
//
// The operator stores, per session, the address to POST to and the key that
// goes into `Authorization: Bearer <key>`. By default only a signal leaves this
// machine: how many requests and direct messages are waiting, never their
// content; the woken session then comes here by itself to fetch them.
//
// With include_text switched on for a hook, the signal also carries the waiting
// bot requests themselves (who asked, the action, the bot, the text), so the
// instruction appears in the bot's own conversation the moment it is woken.
// Requests delivered this way count as taken once the other side accepted the
// signal; when it did not, they stay queued and go out again.
//
// This module decides when a signal is due and records what became of it. The
// HTTP call itself is made by the gateway process, which asks claim() for what
// to send and reports back with report().
//
// A signal is due for a session when all of these hold:
//   - its hook is enabled and work is waiting (queued bot requests, or unread
//     messages in its direct conversations), or the operator asked for a test
//   - it is not listening right now (it would see the work by itself)
//   - the previous signal is at least kMinIntervalSeconds old, so that work
//     arriving in a burst is announced once
//   - some of the work arrived after the previous signal, or that signal is at
//     least kRepeatSeconds old
// A signal that did not reach the other side at all (the network, not an
// answer from it) is tried again on its own for as long as the work waits:
// after kRetryBaseSeconds, then twice as long each time, up to kRepeatSeconds.
// A signal the other side answered with a refusal says something is set up
// wrongly, so that one waits the full kRepeatSeconds.
//
// There is no cap on the number of signals: every new piece of work is
// announced. Only the same announcement is not repeated back to back. The
// vendor's own limit on how often a routine may run still applies on its side
// and shows up here as a refused signal.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"

namespace acm {

class WakeHooks {
public:
    static constexpr std::int64_t kListeningSeconds = 45;
    static constexpr std::int64_t kMinIntervalSeconds = 10;
    static constexpr std::int64_t kRepeatSeconds = 300;
    static constexpr std::int64_t kRetryBaseSeconds = 15;

    WakeHooks(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // Operator: {url, key?, enabled?, include_text?}. The address must be https (plain http is
    // accepted for this machine only). The key is required the first time and
    // kept when omitted later. Returns the hook without its key.
    json set(std::string_view session_id, const json& args);

    // Operator: remove the hook of a session. Idempotent.
    json remove(std::string_view session_id);

    // Operator: send one signal at the next opportunity whether or not work waits.
    json request_test(std::string_view session_id);

    // Operator view of every hook; never contains a key.
    json list();

    // The hook of one session without its key, or null when it has none.
    json find(std::string_view session_id);

    // Gateway: the signals to send now, each with its address and key. Handing
    // one out counts as an attempt, so a second call does not repeat it.
    json claim();

    // Gateway: what became of a claimed signal. {attempt_id, ok, http_status?, detail?}
    json report(const json& args);

private:
    json view(std::string_view session_id);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
