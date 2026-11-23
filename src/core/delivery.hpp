// Delivery into a client's own conversation.
//
// Nothing here pushes into another vendor's application from outside. Each
// client (Claude, Codex, Antigravity) can run a program of ours at fixed points
// of its conversation - its hooks - and takes what that program prints as
// context for the model. The hook program (src/mcp/hook.mjs) calls hook() with
// the session's own credential; this module decides what it gets to print.
//
// Everything here is per window (see window.hpp): each conversation of an
// application is shown what is meant for it, keeps its own marks and is woken
// on its own. A message without target windows is meant for every window of
// its readers; one with targets only for those.
//
//   start, prompt  the conversation starts or the person sends a prompt: every
//                  message for this window that it has neither read nor been
//                  shown, oldest first.
//   stop           the model finished its turn: messages marked urgent that
//                  were not shown yet. The client then continues the turn with
//                  them instead of stopping.
//   watch          a background hook that waits while the conversation is
//                  idle and, where the client supports it, wakes the model:
//                  same selection as stop. One watcher per window.
//
// A window whose client offers no way to be woken from inside is served by the
// gateway instead: claim() hands it the urgent messages together with the
// client's own id of the conversation, the gateway runs the vendor's command
// for adding a message to that conversation and report() records the outcome.
// A conversation the vendor says it cannot continue is not tried again.
//
// What was shown is tracked by row position, per window: shown_rowid for
// everything the start/prompt hooks printed, urgent_rowid for what any urgent
// route delivered. Nothing is marked read here: check_in still returns the
// messages once, so a client that dropped the hook's output loses nothing.
// For the same reason an urgent message that is still unread at the next
// prompt is listed there again: the urgent delivery may have reached nobody.
//
// Against windows waking each other in a circle: the number of urgent
// deliveries per window is capped per ten minutes, the idle route keeps a
// minimum distance between two starts and gives up after repeated failures
// until the window is used again, and Messages caps how many messages a
// session may mark urgent per hour.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"
#include "window.hpp"

namespace acm {

class Delivery {
public:
    // How many messages one hook run lists, and how much of each.
    static constexpr std::int64_t kMaxListed = 8;
    // A window that has messages waiting for its answer is reminded of them in its prompt
    // hook, this often at most (some clients run that hook before every call of the model).
    static constexpr std::int64_t kReminderSeconds = 600;
    static constexpr std::int64_t kReminderListed = 5;
    static constexpr std::size_t kReminderBytes = 200;
    static constexpr std::size_t kBodyBytes = 1200;
    // A message that is not addressed to the window it is shown to: enough to see
    // what it is about. check_in and read_messages have the rest.
    static constexpr std::size_t kBriefBytes = 300;
    static constexpr std::size_t kDigestBytes = 3000;
    static constexpr std::size_t kUrgentBodyBytes = 4000;
    // All message text of one hook run. The first entries get their full allowance; once
    // this is spent, each further one gets a few lines.
    static constexpr std::size_t kHookBytes = 10000;
    static constexpr std::size_t kLeastBytes = 200;
    // Urgent deliveries (stop, watch, command) a window gets within kWindowSeconds.
    static constexpr std::int64_t kMaxUrgentDeliveries = 6;
    static constexpr std::int64_t kWindowSeconds = 600;
    // Idle route: how long after the end of a turn it may start, how long after
    // a tool call a window without hooks counts as idle, how long a watcher
    // counts as alive, the distance between two starts, when a failed start is
    // tried again, how many failures in a row end it, and after how long a start
    // that never reported counts as lost.
    static constexpr std::int64_t kSettleSeconds = 5;
    // How long a window may take to show a sign of life (a hook, a tool call) after a
    // message was handed to its application, before it is started another way; and
    // for how long after the handing over that is still worth doing.
    static constexpr std::int64_t kConfirmSeconds = 90;
    static constexpr std::int64_t kConfirmWindowSeconds = 3600;
    static constexpr std::int64_t kToolIdleSeconds = 120;
    static constexpr std::int64_t kWatchAliveSeconds = 90;
    static constexpr std::int64_t kMinIntervalSeconds = 30;
    static constexpr std::int64_t kRetrySeconds = 300;
    static constexpr std::int64_t kMaxFailures = 3;
    static constexpr std::int64_t kLostSeconds = 900;

    Delivery(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(clock), windows_(database, events, clock) {}

    // Hook program: {event, client?, client_session?, cwd?, watch_id?, fresh?, peek?}.
    // Returns {window, count, urgent, more, text, messages, superseded}. `text`
    // is what the hook prints, empty when there is nothing to show. With peek
    // nothing is recorded as shown.
    json hook(const Session& session, const json& args);

    // Gateway: urgent messages to deliver by running the client's command, for
    // windows that are idle and have no watcher. Each job counts as an attempt.
    // {clients?}: the clients the gateway has a command for; without it, all.
    // The list is remembered so the console can say which clients can be started.
    json claim(const json& args = json::object());

    // Gateway: what became of a claimed job. {delivery_id, ok, detail?}
    json report(const json& args);

    // Operator view, one entry per session with a window, the windows inside.
    json list();

    // The clients the gateway last said it can start; empty before its first claim.
    json command_clients();

    // Gateway: a client has used up its quota (its own error said so), or has it
    // again. {client, until?, detail?}: with `until` (RFC 3339, when the vendor
    // says it can be used again) nothing is started for that client before then;
    // without it the mark is cleared. Returns limits().
    json set_limit(const json& args);

    // The clients that are out of quota now: {client: {until, detail, noted_at}}.
    // Marks whose time has passed are left out.
    json limits();

    // The limit of one client, or null.
    json limit_of(std::string_view client);

    // Gateway: a turn it started in a window's own conversation from the command line
    // is over ({window_id}). Such a turn does not always report its end through the
    // hooks; without this the window would count as busy for Windows::kTurnSeconds.
    json turn_ended(const json& args);

private:
    struct Pending {
        std::int64_t rowid;
        std::string message_id;
        std::string body;
        bool urgent;
        std::string created_at;
        std::string from;
        std::string where;
        bool to_you;
        // Sent to this session alone (named as its only kind of reader, or in a direct conversation).
        bool personal = false;
        // Written by another window of this same session.
        bool own = false;
    };
    // Messages for window `window_id` of `session_id` after row `floor`.
    std::vector<Pending> pending(std::string_view session_id, std::string_view window_id, std::int64_t floor,
                                 bool urgent_only, std::int64_t limit);
    // The urgent ones among them that interrupt this window: an urgent message
    // interrupts the windows it names. One that names no window but is for a
    // session alone (it is the only reader named, or it is that session's direct
    // conversation) interrupts the window that session used last, once. A message
    // to everybody interrupts nobody: it waits for each window's next prompt.
    std::vector<Pending> interrupting(std::string_view session_id, std::string_view window_id, std::int64_t floor);
    std::int64_t last_rowid();
    static std::string compose(const std::vector<Pending>& listed, std::int64_t more, std::string_view route,
                               std::string_view window_name);
    json view(std::string_view session_id);

    Database& database_;
    EventLog& events_;
    Clock clock_;
    Windows windows_;
};

}  // namespace acm
