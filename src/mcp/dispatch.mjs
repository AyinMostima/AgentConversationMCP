// Delivers urgent messages to a session whose client is idle and cannot be
// woken from inside its conversation, by running that client's own command for
// "add a message to this existing conversation".
//
// Only a command the vendor documents for exactly that purpose is used:
//
//   codex   codex queue --thread <id> --message <text>
//           queues the message for the thread through Codex's own local
//           app-server, the same one its desktop app talks to.
//
// Claude needs none: its watcher hook wakes the model inside the conversation
// (see hook.mjs). Antigravity has none: its command line works on a copy of an
// app conversation, and Google does not allow driving it from other software on
// consumer plans. For both, urgent messages arrive with the end of the running
// turn or with the next prompt.
//
// The control service decides when a delivery is due (see src/core/delivery.hpp);
// this module runs the command and reports how it ended. The id of the
// conversation comes from that client's own hook, so a client that never ran a
// hook is never started from here.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RUN_TIMEOUT_MS = 120000;

/**
 * The command per client, as a function from a job to {file, args}; clients
 * whose command is not installed are left out. ACM_DISPATCH_COMMANDS (JSON:
 * {"codex": ["node", "stand-in.mjs"]}) replaces a command; tests use it. The
 * conversation id and the text are then appended as two arguments.
 */
export function dispatchCommands(env = process.env) {
  const commands = {};
  const codexEntry = join(env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (existsSync(codexEntry)) {
    // The npm shim is a .cmd file, which cannot be started without a shell; its target can.
    commands.codex = (job) => ({ file: process.execPath, args: [codexEntry, 'queue', '--thread', job.client_session, '--message', job.text] });
  }
  if (env.ACM_DISPATCH_COMMANDS) {
    for (const [client, words] of Object.entries(JSON.parse(env.ACM_DISPATCH_COMMANDS))) {
      if (words === null) {
        delete commands[client];
      } else {
        commands[client] = (job) => ({ file: words[0], args: [...words.slice(1), job.client_session, job.text] });
      }
    }
  }
  return commands;
}

/** Runs one command without a shell; resolves to {ok, detail}. */
function run({ file, args }, cwd) {
  return new Promise((done) => {
    let tail = '';
    const keep = (chunk) => {
      tail = `${tail}${chunk}`.slice(-600);
    };
    let child;
    try {
      child = spawn(file, args, { cwd: cwd !== null && cwd !== undefined && existsSync(cwd) ? cwd : undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ ok: false, detail: `could not start: ${error.message}`.slice(0, 300) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, detail: `no result within ${RUN_TIMEOUT_MS / 1000} seconds` });
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, detail: `could not start: ${error.message}`.slice(0, 300) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const said = tail.replace(/\s+/g, ' ').trim();
      done(code === 0 ? { ok: true, detail: said.slice(-200) || undefined } : { ok: false, detail: `exit code ${code}${said === '' ? '' : `: ${said.slice(-260)}`}` });
    });
  });
}

/**
 * Starts the periodic check. `adminToken()` returns the operator credential of
 * the local service; `say(line)` receives one-line diagnostics. Returns a
 * function that stops the check.
 */
export function startDispatcher({ coreUrl, adminToken, intervalMs = 5000, say, commands = dispatchCommands() }) {
  let busy = false;
  let lastProblem = '';

  async function local(path, body) {
    const response = await fetch(`${coreUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken() },
      body: JSON.stringify(body ?? {}),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      // Naming the clients also tells the console which ones can be started from here.
      const { jobs } = await local('/api/v1/delivery/claim', { clients: Object.keys(commands) });
      for (const job of jobs) {
        const outcome = await run(commands[job.client](job), job.cwd);
        await local('/api/v1/delivery/report', { delivery_id: job.delivery_id, ...outcome });
        say(`urgent delivery to ${job.session_id} (${job.client}): ${outcome.ok ? 'handed over' : outcome.detail}`);
      }
      lastProblem = '';
    } catch (error) {
      if (error.message !== lastProblem) {
        lastProblem = error.message;
        say(`delivery check failed: ${error.message}`);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
