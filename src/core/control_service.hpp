// The control service is the only rule entry. The MCP gateway, the operator
// API and (later) provider adapters all call these two functions; nothing else
// touches the store. Agent commands are authenticated from the presented
// credential and gated on an approved pairing before they are dispatched.
#pragma once

#include "board.hpp"
#include "bot_control.hpp"
#include "common.hpp"
#include "conversation.hpp"
#include "database.hpp"
#include "delivery.hpp"
#include "event_log.hpp"
#include "identity.hpp"
#include "message.hpp"
#include "progress.hpp"
#include "wake.hpp"
#include "window.hpp"

#include <filesystem>
#include <mutex>

namespace acm {

class ControlService {
public:
    // Opens `<data_dir>/acm.db`, applies migrations and expires overdue pairings.
    explicit ControlService(const std::filesystem::path& data_dir,
                            Clock clock = [] { return std::chrono::system_clock::now(); });

    // Agent entry. `tool` is one of the names in agent_tools().
    // `context` is what the entry point knows about the caller beyond its
    // credential: {client?, client_session?}, the application and its own id of
    // the conversation the call comes from. It selects the caller's window.
    json call_tool(std::string_view token, std::string_view tool, const json& args,
                   const json& context = json::object());

    // Bridge entry: self-enrollment of a credential the bridge generated itself.
    // See Identity::enroll. An enrolled, linked session also joins its lobby.
    json enroll(std::string_view token, const json& args);

    // Hook entry: a client's hook program asks what to put into its conversation.
    // Authenticated by the session's own credential. See Delivery::hook.
    json hook(std::string_view token, const json& args);

    // Operator entry. `target_id` carries the path id for operations on one entity.
    json admin(std::string_view operation, std::string_view target_id, const json& args);

    // Committed events with event_id > after, plus the current watermark.
    json events_after(std::int64_t after, std::int64_t limit);

    static const std::vector<std::string>& agent_tools();
    // Version of the tool contract: raised whenever a tool is added or removed or
    // the parameters of one change. Must equal TOOL_CONTRACT in src/mcp/tools.mjs;
    // a bridge that reports another number was started before the change.
    static constexpr int kToolContract = 5;
    int schema_version();

private:
    // One call that brings a session up to date: goals, task boards and unread messages.
    json check_in(const Session& session, const json& args, const Window* window);
    // The sessions a caller can address, each with its windows.
    json roster(const Session& session, const Window* window, bool all_windows = false);
    // Compacting a conversation: its messages (Conversations::compact) and its board (close_tasks).
    json compact(const Session* session, const json& args, const std::string& by);
    // Activity of the last `days` days for the console's overview: messages per
    // hour (one day) or per day, and who, where, how urgent messages were handed
    // over, and the boards as they stand. Counts only, never text.
    json stats(std::int64_t days);
    // The windows named in args.to_windows, resolved within the caller's project.
    std::vector<Window> target_windows(const Session& session, const json& args);
    json settings_view();
    // Entry-point command, not part of the tool contract: a session sets up, tests,
    // inspects or removes the signal that triggers it from outside. {op, url?, key?, include_text?}
    json own_wake_hook(const Session& session, const json& args);
    // Remote access to the console through a tunnel: the operator's settings and
    // the state the gateway last reported. Never contains the tunnel credential.
    json remote_view();

    std::mutex mutex_;
    Database database_;
    EventLog events_;
    Identity identity_;
    Conversations conversations_;
    Messages messages_;
    Progress progress_;
    Board board_;
    BotControl bots_;
    WakeHooks wake_;
    Delivery delivery_;
    Windows windows_;
    Clock clock_;
};

}  // namespace acm
