// Windows: the single conversations of a client application.
//
// A session is one application (Claude, Codex, ...), because that is what holds
// a credential. A person runs several conversations in one application at the
// same time, each on its own piece of work, and those have to be told apart:
// to say which of them a message is for, to wake exactly that one, to let two
// conversations of the same application hear each other, and to let each keep
// its own place in what it has read.
//
// A window is such a conversation. It is known by the id its client gives it
// (Claude's session id, Codex's thread id, Antigravity's conversation id), which
// reaches us from two sides that have to agree: the client's hooks report it
// with every run, and the bridge reports it with every tool call. A window has
// a name others address it by. It starts with a generated one and may give
// itself a better one.
//
// Windows share their session's identity and permissions: what a session may
// read, each of its windows may read. Receipts stay per session too. What is
// per window is routing (which window gets a message put in front of it, which
// one is woken) and the read cursor.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"
#include "identity.hpp"

namespace acm {

struct Window {
    std::string window_id;
    std::string session_id;
    std::string name;
};

class Windows {
public:
    // A window that neither ran a hook nor called a tool for this long is not
    // offered for addressing any more; it comes back by being used.
    static constexpr std::int64_t kLiveSeconds = 24 * 3600;
    // A window whose client last reported the start of a turn counts as in that
    // turn for this long at most; a turn that was interrupted reports no end.
    static constexpr std::int64_t kTurnSeconds = 1800;
    // A window that is seen for the first time is shown what was written in the
    // last while, not everything its session never read: it was not there for
    // that. And nothing that was urgent before it existed interrupts it now.
    static constexpr std::int64_t kFreshSeconds = 1800;

    Windows(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    // The window a hook run or a tool call belongs to; created on first sight.
    // `client_session` is the client's own id of the conversation. Without one,
    // the call is attributed to the only window of the session that is in a
    // turn right now, when there is exactly one; otherwise to none.
    std::optional<Window> resolve(const Session& session, const std::optional<std::string>& client,
                                  const std::optional<std::string>& client_session,
                                  const std::optional<std::string>& cwd);

    // Operator: {client, windows: [{client_session, name?, title?, cwd?, seen_at}], not_windows?: [client_session]}. Makes
    // the conversations a client has on record known as windows of that client's
    // session, so that one that has not done anything since the service runs can
    // still be addressed and woken. A conversation that is a window already keeps
    // what it has; its title and, while it is only known from the record, when it
    // was last active are brought up to date. A new one is named after `name`, or
    // else after its title. The ids in
    // `not_windows` are conversations of that client that are no windows (its
    // sub-agents, for one): one that became a window by calling a tool is retired.
    // Returns {session_id, added, known, retired}; without a session of that
    // client, nothing happens.
    json import(const json& args);

    // Agent: {name}. A window names itself. Fails NAME_TAKEN when another live
    // window of the project holds the name.
    json rename(const Session& session, const Window& window, const json& args);

    // What a client or a model said about which model is at work in a window (and,
    // as a fallback for calls that belong to no window, in its session). Ignored
    // when empty.
    /// Records which model is at work in a window (or, for a client without windows, in its
    /// session). The first time it is known, what was written there before gets it as well:
    /// everything, or only what is not older than `since` when the client knows that the model
    /// changed at that time.
    /// Windows that wrote messages which carry no model, and whose client keeps a record
    /// that may name it: {windows: [{window_id, client, client_session}]}.
    json wanting_model();
    /// What the gateway read from those records: {models: [{window_id, model, since?}]}.
    json label_models(const json& args);
    /// The model known for a window, or for the session of a client without windows.
    std::optional<std::string> model_of(const Session& session, const Window* window);
    void note_model(const Session& session, const Window* window, const std::optional<std::string>& model,
                    const std::optional<std::string>& since = std::nullopt);

    // Operator: {name} for any window.
    json admin_rename(std::string_view window_id, const json& args);

    // Live windows named by `handles` (names or window ids) within a project.
    // Fails UNKNOWN_WINDOW and lists the names that exist.
    std::vector<Window> lookup(std::string_view project_id, const std::vector<std::string>& handles);

    // Live windows of one session, for rosters: {window_id, name, title, state, last_active_at, cwd, is_you, imported}.
    // At most `limit` of them, the most recently used first; the caller's own is always among them.
    static constexpr std::int64_t kRosterWindows = 8;
    json of_session(std::string_view session_id, const Window* self, std::int64_t limit = 40);
    // How many live windows the session has in all.
    std::int64_t count_of_session(std::string_view session_id);
    // Which client application a window belongs to (codex, claude, antigravity, ...); empty when unknown.
    std::string client_of(std::string_view window_id);

    // Operator view of one window.
    json view(std::string_view window_id);

    // idle, busy or watching, from what the client last reported (times as stored).
    std::string state_of(std::string_view event, std::string_view seen_at,
                         const std::optional<std::string>& watch_seen_at);

private:
    void set_name(std::string_view window_id, const std::string& name);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
