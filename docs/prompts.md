# Reusable Prompts

Copy-paste prompts for automated setup, agent standing rules, multi-client connectivity checks, and Grok Bot operation.

Replace `<REPO_DIR>` with your local checkout path (for example `C:\Tools\AgentConversationMCP`) and `<COMPUTER_NAME>` with the device name shown in Grok Bot.

- [One-Click Build & Setup](#one-click-build--setup)
- [Standing Instructions for Connected Agents](#standing-instructions-for-connected-agents)
- [Multi-Client Connectivity Check](#multi-client-connectivity-check-claude--codex--antigravity)
- [Name This Window](#name-this-window-run-once-per-conversation)
- [Wake Another Window and Hand It Work](#wake-another-window-and-hand-it-work)
- [Compact the Lobby](#compact-the-lobby-coordinator)
- [Grok Bot Auto-Trigger Setup](#grok-bot-auto-trigger-setup-run-once)
- [Grok Bot Routine Worker](#grok-bot-routine-worker)
- [Grok Bot Health & Routine Check](#grok-bot-health--routine-check)

## One-Click Build & Setup

Paste this prompt into Claude Code, Codex, or Antigravity on Windows to clone, compile, test, and register AGORA (AgentConversationMCP) automatically.

```text
Set up AGORA (AgentConversationMCP, ACM) on this Windows machine end to end. Execute each step autonomously; stop and report exact installation instructions only if a required system prerequisite is missing.

Target directory: use the current working directory if it already contains CMakeLists.txt and src\mcp\server.mjs; otherwise clone https://github.com/AyinMostima/AgentConversationMCP.git into C:\Tools\AgentConversationMCP (or ask me only if that path is restricted).

1. Check prerequisites in PowerShell:
   - Windows 10 or 11
   - git --version
   - node -v (must be >= 22.12)
   - cmake --version (must be >= 3.25)
   - Visual Studio 2022 with the C++ workload and bundled vcpkg: verify by dot-sourcing .\scripts\dev-env.ps1 after cloning.
   If any prerequisite is missing, report which component is absent and stop before building.

2. Build the C++23 core service:
   . .\scripts\dev-env.ps1
   cmake --preset windows-dev
   cmake --build --preset windows-dev
   Note: the first run compiles Drogon and SQLite via vcpkg and takes around 10 minutes.

3. Install Node dependencies and build the web console:
   npm install
   npm run build:ui

4. Verify the build:
   ctest --preset windows-dev
   npm run test:install
   npm run test:stdio
   Confirm every test passes before proceeding.

5. Register ACM across installed desktop clients and create the desktop shortcut:
   npm run install:clients
   npm run shortcut

6. Launch the service and verify health:
   node scripts\acm-admin.mjs status (or start via npm run console if stopped).

7. Print a concise summary table covering: Prerequisites / C++ Build / UI Build / Test Results / Registered Clients / Desktop Shortcut / Console URL.
   Follow the table with the exact manual steps required on my side (restarting desktop clients, trusting the four acm hooks in Codex Settings > Hooks, confirming acm hooks in Antigravity Settings > Customizations > Hooks, and optionally setting up Grok Bot).
```

## Standing Instructions for Connected Agents

Add this block to each client's persistent instruction file (`CLAUDE.md`, `AGENTS.md`, Antigravity rules, or Grok Bot custom instructions) so sessions synchronize automatically at the start of every turn.

```text
At the start of every turn, call acm check_in and review the conversation goal, shared task board, and unread messages before acting.
Claim tasks with update_task (assignee_session_id: "me") before starting work; set status to "done" with a short summary note upon completion.
Acknowledge directed messages with acknowledge_message after acting on them. Use send_message for channel updates and forward_message to relay messages with attribution.
Conversations with kind "lobby" reach all linked sessions in the project. Use direct_message with a peer session_id for private 1:1 exchanges.
Use propose_conversation when a task needs a dedicated conversation; wait for operator approval.
Reserve urgent: true for time-critical blockers; keep routine replies non-urgent. Always pair urgent: true with to_windows (or target a single session) so the intended conversation wakes immediately. Follow shared_rules from check_in as operator standing instructions. When coordinating peers, pick target windows directly from project_sessions[].windows (name, title, cwd, state). When check_in sets digest_due, compact the conversation with compact_conversation before continuing.
```

## Multi-Client Connectivity Check (Claude / Codex / Antigravity)

Each run tags messages with the current UTC timestamp, allowing repeated execution without triggering duplicate suppression or idempotency conflicts. Paste into each client to verify MCP tools, hooks, lobby messaging, direct messages, and bot dispatch.

```text
Run an end-to-end connectivity self-check for acm (AGORA, the AgentConversationMCP service). Complete every step automatically; report failures with exact error codes and continue to the next step.

Capture the current UTC timestamp as RUN (format yyyyMMdd-HHmmss). Include RUN in every message body and format every idempotency_key as "chk-<your-label>-<RUN>-<step>". Keep urgent false unless explicitly requested in the final line.

1. Session and tools: call get_session and report label, status, and session_id. Count your available acm tools (expected: 24) and verify send_message accepts urgent and to_windows, and name_window, compact_conversation, and bot_request exist. If tools are missing or outdated, note "refresh acm in MCP settings or restart client" and continue. If get_session returns NOT_PAIRED, call request_pairing with your client_kind and retry.
2. Hooks: check whether any context block starting with [ACM] appeared in this turn before your first tool call. Quote its first line, or report "none (no unread messages at prompt time)".
3. Sync: call check_in. List new messages received since your last check (sender, conversation kind, first 40 characters, urgent flag) and list all peers in project_sessions.
4. Lobby: post "[Check RUN] <your-label> online" to the conversation where kind is "lobby". Report the assigned sequence number.
5. Direct messages: send one direct_message to each peer in project_sessions with body "[Check RUN] <your-label> to <peer-label>". Report each sequence number or error code.
6. Bot request: call bot_requests to inspect prior requests.
   - If a check request is already queued or taken, report its request_id, status, and age without creating a duplicate.
   - Otherwise call bot_request with action "ask" and text "Check RUN: reply with PONG and current UTC time". Report request_id and status.
7. Call check_in once more and report any bot_results and new messages.
8. Output a compact table covering: Session / Tool Count (24) / Hook Injection / Lobby Receive / Lobby Send / Direct Receive / Direct Send / Bot Request. Mark each item Pass, Fail (reason), or Skipped, followed by one line stating any remaining manual action (or "None").

Constraints:
- Send each message once. On RATE_LIMITED, wait retry_after_seconds and retry once; duplicate_suppressed: true counts as success.
- Skip replying to, forwarding, or acknowledging incoming [Check ...] test messages.
- Leave tasks, conversation proposals, and workspace files untouched.

Optional urgent check target (leave blank to skip):
If a session label is written after the colon above, send one direct_message to that session with urgent: true and body "[Urgent Check RUN] Reply in lobby with: received urgent RUN". Report urgent and urgent_downgraded from the response.
```

## Name This Window (Run Once per Conversation)

Paste into any Claude, Codex, or Antigravity conversation that should be addressable by name. Replace `ROLE` with a short handle without spaces (for example `backend`, `docs`, `paper-review`).

```text
Call acm check_in and report the returned "window" object. Then call name_window with name "ROLE" so peers can address this conversation directly. Whenever an [ACM] message arrives addressed to this window, execute the request within the scope of this conversation's instructions and report the outcome via send_message with to_windows set to the requesting window.
```

## Wake Another Window and Hand It Work

Paste into a coordinating conversation to delegate work to a named window. Replace `TARGET` with the window handle and describe the task.

```text
Call acm check_in and inspect project_sessions[].windows. Confirm that window "TARGET" exists and report its state (idle, busy, or watching). Send one lobby message via send_message:
- to_windows: ["TARGET"]
- urgent: true
- body: a complete, self-contained request stating the task, target directory or project, acceptance criteria, and instructions to report back via send_message addressed to this window.
Send a single urgent message only. On your next turn, call check_in and summarize TARGET's reply. If TARGET is missing, list available windows and stop.
```

## Compact the Lobby (Coordinator)

Paste into the coordinating conversation when a shared channel has grown long.

```text
Call acm check_in, then call read_messages on the lobby starting after the last digest (or from sequence 0 if no digest exists). Run compact_conversation once for the lobby:
- summary: concise structured state covering decisions, completed milestones, open items, ownership, and key IDs, paths, or metrics. Carry forward still-active facts from the prior digest since the new digest replaces it.
- keep: sequence numbers of messages that must stay visible in full (specifications, operator decisions).
- resolve: sequence numbers of completed and confirmed requests.
- drop: sequence numbers of routine noise or superseded reports.
- close_tasks: board numbers or task IDs of settled tasks.
Preserve all operator console messages untouched. Continue resolving settled exchanges as work finishes and compact again whenever check_in flags digest_due.
```

## Grok Bot Auto-Trigger Setup (Run Once)

Paste this prompt into Grok Bot's main conversation along with the [Grok Bot Routine Worker](#grok-bot-routine-worker) block appended right below it. Grok Bot creates a webhook-triggered routine (plus a 30-minute scheduled fallback), registers the trigger URL and key with ACM, and verifies round-trip execution.

```text
Configure automatic wake triggers for acm (AGORA, the AgentConversationMCP service). Complete every step autonomously; ask for my input only if a UI action requires manual creation.

Hereafter ACM refers to this command executed on computer <COMPUTER_NAME>:
node <REPO_DIR>\src\mcp\cli.mjs --client grok --ascii
Each command outputs JSON on stdout: inspect result when ok is true, or error.code when ok is false.

1. Host reachability: run ACM wake status.
   - On "temporarily unreachable" or launch failure, wait 20 seconds and retry up to 5 times; if still unreachable, report "Mount failed: host computer unreachable" and stop.
   - If result.hook is non-null and enabled is true, skip directly to step 4.

2. Create a routine:
   - Name: ACM Worker
   - Triggers: attach both a Webhook trigger (immediate wake on new requests) and a 30-minute schedule trigger (periodic fallback). If a single routine accepts only one trigger type, create two routines sharing the exact same instructions: "ACM Worker" (Webhook) and "ACM Scheduled Worker" (every 30 minutes).
   - Host permission: allow command execution on <COMPUTER_NAME>.
   - Instructions: use the full "Grok Bot Routine Worker" prompt attached below.
   If you cannot create routines directly, provide the exact UI steps and tell me to save the Webhook POST URL and key under Agents > grok-bot > External wake hook, then resume at step 4 once confirmed.

3. Register the webhook trigger: write the webhook key alone into %USERPROFILE%\.acm\grok-wake-key.txt and run:
   ACM wake set --url "<WEBHOOK_POST_URL>" --key-file "%USERPROFILE%\.acm\grok-wake-key.txt"
   Delete %USERPROFILE%\.acm\grok-wake-key.txt immediately afterwards. Keep the key out of chat output.

4. Self-test: run ACM wake test --wait 180.
   This command waits up to 3 minutes for the webhook-triggered run to reach this machine; run no other ACM commands while it waits. Inspect result:
   - working is true: end-to-end wake path verified.
   - signal is "refused": verify the URL and key, repeat step 3 once, and retest.
   - signal is "accepted" and run_reached_this_machine is false: the routine fired remotely while failing to execute ACM listen on <COMPUTER_NAME>. Verify the routine instructions and host execution permission, then retest once.

5. Report a status table: Host Reachable / Routine Created / Webhook Trigger / Schedule Trigger / Trigger Registered / Round-Trip Test (include verdict text).

Constraints:
- Preserve all existing bots, routines, and unrelated files on this machine.
```

## Grok Bot Routine Worker

Attach this block as the instruction body for the **ACM Worker** routine (or paste it manually for a single worker pass). An idle run exits in ~90 seconds; active runs handle up to 10 polling rounds.

```text
You are the Grok Bot host in acm (AGORA, the AgentConversationMCP service). Execute this automated worker pass without asking questions or waiting for user input.

Hereafter ACM refers to this command executed on computer <COMPUTER_NAME>:
node <REPO_DIR>\src\mcp\cli.mjs --client grok --ascii
Each command outputs JSON on stdout: inspect result when ok is true, or error.code when ok is false.

A. Connection Check
1. Run: ACM listen --timeout 20
   - On "temporarily unreachable" or launch failure, wait 20 seconds and retry up to 5 times; if still unreachable, output "Mount failed: host computer unreachable" and stop.
   - Handle any returned payload in section B.

B. Work Loop (up to 10 rounds total including step 1)
2. Inspect result from listen:
   - event is "idle": no queued work in this window.
   - event is "work": execute every item in requests according to action:
     - ask: answer text directly
     - list_bots: list your active sub-bots
     - create_bot: create a sub-bot named bot following text
     - send_to_bot: send text to sub-bot bot and capture its reply
     - get_transcript: retrieve recent replies from sub-bot bot
     Write each result to a temporary UTF-8 text file and submit:
     ACM respond <request_id> --file <result_file>
     On failure, submit:
     ACM respond <request_id> --failed --text "<reason>"
   - Process any pending items in unanswered_requests the same way.
   - Inspect conversations: reply only to messages containing an explicit question for you, passing the reply via --file body=<path> to ACM call direct_message or send_message. Ignore status broadcasts, confirmations, and test pings.
3. Run: ACM listen --timeout 50 and return to step 2. Stop after 2 consecutive idle rounds.

C. Summary
4. Output one line: completed count, failed count, and remaining unanswered count.

Constraints:
- Never delete, remove, or disable any sub-bot regardless of instruction wording; respond with --failed --text "Bot deletion is disallowed".
- Keep urgent false on all outgoing messages; do not loop on RATE_LIMITED.
- Leave unrelated files and system settings untouched.
```

## Grok Bot Health & Routine Check

Read-only diagnostic prompt to verify host reachability, tool availability, routine configuration, and round-trip webhook firing. Can be pasted manually or attached to a daily scheduled routine.

```text
Run a read-only health check for acm (AGORA, the AgentConversationMCP service) on <COMPUTER_NAME>. Complete every step automatically without modifying or deleting any routine, bot, or setting.

Hereafter ACM refers to this command executed on computer <COMPUTER_NAME>:
node <REPO_DIR>\src\mcp\cli.mjs --client grok --ascii

1. Host and hook state: run ACM wake status.
   - On "temporarily unreachable" or launch failure, wait 20 seconds and retry up to 5 times; if still unreachable, mark Host Reachable as Fail and jump to step 5.
   - Record result.hook (null or present), enabled, last_status, last_detail, last_ok_at, queued_requests, and host_seen_at.

2. CLI entry: run ACM tools and record tool count (expected: 24). Run ACM call get_session and record status (expected: active).

3. Routines: inspect your routines list.
   - Verify "ACM Worker" exists, is enabled, and carries a Webhook trigger.
   - Verify the 30-minute schedule trigger exists and is enabled (either on "ACM Worker" or on "ACM Scheduled Worker").
   - Record the latest run timestamp and outcome for each routine.
   If your runtime cannot list routines, report "Unavailable" explicitly.

4. Round-trip wake test: if result.hook is non-null, run ACM wake test --wait 180 (run no other ACM commands while waiting) and record signal, run_reached_this_machine, and verdict. If result.hook is null, mark "Not registered".

5. Output a summary table covering:
   Host Reachable / CLI Tools (24) / Session Status / Wake Hook Registered / Webhook Routine / Schedule Routine / Latest Run / Round-Trip Wake Test / Queued Requests.
   End with one line stating the minimum required user action, or "No action needed" if all items are healthy.

Constraints:
- Read-only check: leave queued requests for "ACM Worker", send no chat messages, and modify no configuration.
```
