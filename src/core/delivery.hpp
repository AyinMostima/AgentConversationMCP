// Delivery into a client's own conversation.
//
// Nothing here pushes into another vendor's application from outside. Each
// client (Claude, Codex, Antigravity) can run a program of ours at fixed points
// of its conversation - its hooks - and takes what that program prints as
// context for the model. The hook program (src/mcp/hook.mjs) calls hook() with
// the session's own credential; this module decides what it gets to print.
//
//   start, prompt  the conversation starts or the person sends a prompt: every
//                  unread message that was not shown yet, newest batch first.
//   stop           the model finished its turn: unread messages marked urgent
//                  that were not shown yet. The client then continues the turn
//                  with them instead of stopping.
//   watch          a background hook that waits while the conversation is
//                  idle and, where the client supports it, wakes the model:
//                  same selection as stop.
//
// A session whose client offers no way to be woken while idle is served by the
// gateway instead: claim() hands it the urgent messages together with the
// client's own id of the conversation, the gateway starts the vendor's
// command line for that conversation and report() records the outcome.
//
// What was shown is tracked by row position, per session: shown_rowid for
// everything the start/prompt hooks printed, urgent_rowid for what any urgent
// route delivered. Nothing is marked read here: check_in still returns the
// messages once, so a client that dropped the hook's output loses nothing.
// For the same reason an urgent message that is still unread at the next
// prompt is listed there again: the urgent delivery may have reached nobody.
//
// Against sessions waking each other in a circle: the number of urgent
// deliveries per session is capped per ten minutes, the idle route keeps a
// minimum distance between two starts and gives up after repeated failures
// until the client is used again, and Messages caps how many messages a
// session may mark urgent per hour.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"

namespace acm {

class Delivery {
public:
    // How many messages one hook run lists, and how much of each.
    static constexpr std::int64_t kMaxListed = 8;
    static constexpr std::size_t kBodyBytes = 1200;
    static constexpr std::size_t kUrgentBodyBytes = 4000;
    // Urgent deliveries (stop, watch, command) a session gets within kWindowSeconds.
    static constexpr std::int64_t kMaxUrgentDeliveries = 6;
    static constexpr std::int64_t kWindowSeconds = 600;
    // Idle route: how long after the end of a turn it may start, how long a
    // watcher counts as alive, the distance between two starts, when a failed
    // start is tried again, how many failures in a row end it, and after how
    // long a start that never reported counts as lost.
    static constexpr std::int64_t kSettleSeconds = 5;
    static constexpr std::int64_t kWatchAliveSeconds = 90;
    static constexpr std::int64_t kMinIntervalSeconds = 30;
    static constexpr std::int64_t kRetrySeconds = 300;
    static constexpr std::int64_t kMaxFailures = 3;
    static constexpr std::int64_t kLostSeconds = 900;

    Delivery(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // Hook program: {event, client?, client_session?, cwd?, watch_id?, peek?}.
    // Returns {count, urgent, more, text, messages, superseded}. `text` is what
    // the hook prints, empty when there is nothing to show. With peek nothing is
    // recorded as shown.
    json hook(const Session& session, const json& args);

    // Gateway: urgent messages to deliver by starting the client's command line,
    // for sessions that are idle and have no watcher. Each job counts as an attempt.
    // {clients?}: the clients the gateway has a command for; without it, all.
    // The list is remembered so the console can say which clients can be started.
    json claim(const json& args = json::object());

    // Gateway: what became of a claimed job. {delivery_id, ok, detail?}
    json report(const json& args);

    // Operator view, one entry per session whose client has run a hook.
    json list();

    // The clients the gateway last said it can start; empty before its first claim.
    json command_clients();

private:
    struct Pending {
        std::int64_t rowid;
        std::string message_id;
        std::string body;
        bool urgent;
        std::string created_at;
        std::string from;
        std::string where;
    };
    std::vector<Pending> pending(std::string_view session_id, std::int64_t floor, std::int64_t urgent_floor,
                                 bool urgent_only, std::int64_t limit);
    std::int64_t last_rowid();
    static std::string compose(const std::vector<Pending>& listed, std::int64_t more, std::string_view route);
    json view(std::string_view session_id);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
