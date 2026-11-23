#!/usr/bin/env node
// The program a desktop client runs at fixed points of its conversation (its
// hooks). It asks the local service what other sessions wrote for this one and
// prints it in the form that client takes as context for its model, so the
// messages appear inside the conversation the person is looking at.
//
//   node hook.mjs --client claude|codex|antigravity --event start|prompt|stop|watch
//
//   start   the conversation starts            -> unread messages as context
//   prompt  the person sends a prompt          -> unread messages as context
//           (Antigravity: before each call of the model)
//   stop    the model finished its turn        -> urgent messages; the client
//                                                 continues the turn with them
//   watch   background, where the client can be woken while idle (Claude's
//           asyncRewake): waits until an urgent message arrives, prints it to
//           stderr and exits with code 2, which wakes the model.
//
// Rules this program keeps, because a hook runs inside someone's conversation:
//   - it never blocks the client: every wait has a short limit, and whatever
//     goes wrong (no identity yet, service not running, bad input) ends in
//     "nothing to add" with exit code 0;
//   - it never starts the service and never registers an identity: that is the
//     MCP bridge's job, and a client that has not used the bridge has no session;
//   - it prints nothing but the client's own output format on stdout.
// Each run leaves one line in <data>/logs/hooks.log, which is where to look when
// a client seems not to run its hooks.
//
// Options: --data-dir DIR  --core-port N  --identity-file PATH
//          --max-seconds N  (watch: how long to wait, default 14000)
//          --interval-ms N  (watch: how often to ask, default 3000)
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDataDir } from './paths.mjs';
import { recordedModel } from './record.mjs';

const CLIENTS = ['claude', 'codex', 'antigravity'];
const EVENTS = ['start', 'prompt', 'stop', 'watch', 'tool'];
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 2500;
const STDIN_TIMEOUT_MS = 1500;
const LOG_LIMIT_BYTES = 512 * 1024;

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1 || argv[index + 1] === undefined) {
    return fallback;
  }
  return argv[index + 1];
}

/**
 * What the client told the hook about itself. Each client names the fields in
 * its own way; a hook started without input simply has none.
 */
export function readInput(client, raw, event) {
  let input = {};
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed !== null && typeof parsed === 'object') {
      input = parsed;
    }
  } catch {
    // No input, or not JSON: nothing is known about the conversation.
  }
  const text = (value) => (typeof value === 'string' && value !== '' ? value.slice(0, 250) : undefined);
  // Which model runs the conversation. The client says so in its input (Codex with
  // every hook, Claude only when a session starts); otherwise its own record of the
  // conversation does, which names the model of every turn. A model object is named by its id.
  const named = text(typeof input.model === 'object' && input.model !== null ? (input.model.id ?? input.model.name) : input.model) ?? text(input.modelId) ?? text(input.modelName);
  const recorded = recordedModel(input.transcript_path);
  const model = named ?? recorded.model;
  // Known to have changed within the record: what was written before that is not this model's.
  const modelSince = recorded.model === model ? recorded.since : undefined;
  if (client === 'antigravity') {
    const workspace = Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined;
    return { clientSession: text(input.conversationId), cwd: text(input.cwd) ?? text(workspace), model, modelSince };
  }
  return { clientSession: text(input.session_id), cwd: text(input.cwd), model, modelSince, persistent: client === 'codex' ? keeps(input, event) : undefined };
}

/**
 * Whether the client keeps this conversation, as far as its hook input tells.
 * Codex runs its hooks for helper threads as well (the one that names a new
 * conversation, for example) and stores no record of those: such a thread can
 * never be continued, so nobody should address or wake it. Its input names the
 * record in transcript_path. Undefined when it cannot be told yet.
 */
function keeps(input, event) {
  if (!('transcript_path' in input)) {
    return undefined;
  }
  if (typeof input.transcript_path !== 'string' || input.transcript_path === '') {
    return false;
  }
  if (existsSync(input.transcript_path)) {
    return true;
  }
  // The record may be written a moment after the conversation starts; by the end of a turn it exists.
  return event === 'stop' ? false : undefined;
}

/**
 * The client's own output for "put this text in front of the model".
 * Returns {stdout, stderr, code}. With no text it is each client's "nothing to add".
 */
export function render(client, event, text) {
  const nothing = { stdout: client === 'antigravity' ? '{}' : '', stderr: '', code: 0 };
  if (text === '') {
    return nothing;
  }
  if (event === 'watch') {
    // Claude's asyncRewake: exit code 2 wakes the model with what is on stderr.
    return { stdout: '', stderr: text, code: 2 };
  }
  if (client === 'antigravity') {
    if (event === 'stop') {
      return { stdout: JSON.stringify({ decision: 'continue', reason: text }), stderr: '', code: 0 };
    }
    return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] }), stderr: '', code: 0 };
  }
  // Claude and Codex share one contract for these events.
  if (event === 'stop') {
    return { stdout: JSON.stringify({ decision: 'block', reason: text }), stderr: '', code: 0 };
  }
  // "tool": after a tool call, in the middle of a turn. What is urgent for this
  // conversation is put in front of the model now, not when the turn is over.
  const hookEventName = event === 'start' ? 'SessionStart' : event === 'tool' ? 'PostToolUse' : 'UserPromptSubmit';
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }), stderr: '', code: 0 };
}

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) {
      done('');
      return;
    }
    let data = '';
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      // A client that never closes the pipe must not keep this process alive.
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      done(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  const client = option('--client', '');
  const event = option('--event', '');
  if (!CLIENTS.includes(client) || !EVENTS.includes(event)) {
    process.stderr.write(`usage: hook.mjs --client ${CLIENTS.join('|')} --event ${EVENTS.join('|')}\n`);
    process.exitCode = 0;
    return;
  }
  const dataDir = resolveDataDir(option('--data-dir'));
  const coreUrl = `http://${HOST}:${option('--core-port', '8766')}`;
  const identityFile = resolve(option('--identity-file', join(dataDir, 'identities', `${client}.json`)));

  function note(outcome) {
    try {
      const file = join(dataDir, 'logs', 'hooks.log');
      mkdirSync(join(dataDir, 'logs'), { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // First line of a new file.
      }
      const line = `${new Date().toISOString()} ${client} ${event} ${outcome}\n`;
      if (size > LOG_LIMIT_BYTES) {
        writeFileSync(file, line);
      } else {
        appendFileSync(file, line);
      }
    } catch {
      // The log is a convenience; a hook never fails over it.
    }
  }

  if (process.env.ACM_HOOKS === 'off') {
    // A conversation that ACM itself started as a stand-in for another one: it is
    // not a window of its own, and it was handed what it needs when it was started.
    process.stdout.write(render(client, event, '').stdout);
    return;
  }

  let token = (process.env.ACM_SESSION_TOKEN ?? '').trim();
  if (token === '') {
    try {
      token = String(JSON.parse(readFileSync(identityFile, 'utf8')).token ?? '');
    } catch {
      token = '';
    }
  }
  if (!/^acm_[0-9a-f]{48}$/.test(token) && (process.env.ACM_SESSION_TOKEN ?? '') === '') {
    note('no identity yet (the client has not used the acm tools)');
    process.stdout.write(render(client, event, '').stdout);
    return;
  }

  const input = readInput(client, await readStdin(), event);

  /** One call to the service; resolves to its result, or undefined when it cannot be reached or refuses. */
  async function ask(body) {
    try {
      const response = await fetch(`${coreUrl}/internal/v1/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ client, client_session: input.clientSession, cwd: input.cwd, persistent: input.persistent, model: input.model, model_since: input.modelSince, ...body }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const envelope = await response.json();
      return envelope.ok ? envelope.result : { refused: envelope.error?.code ?? `HTTP ${response.status}` };
    } catch (error) {
      return { unreachable: error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code ?? error.message) };
    }
  }

  function finish(text) {
    const out = render(client, event, text);
    if (out.stdout !== '') {
      process.stdout.write(out.stdout);
    }
    if (out.stderr !== '') {
      process.stderr.write(out.stderr);
    }
    process.exitCode = out.code;
  }

  if (event !== 'watch') {
    const result = await ask({ event });
    if (result.unreachable !== undefined || result.refused !== undefined) {
      note(result.unreachable !== undefined ? `service not reachable (${result.unreachable})` : `refused (${result.refused})`);
      finish('');
      return;
    }
    note(`shown ${result.count}${result.urgent > 0 ? ` (${result.urgent} urgent)` : ''}${result.held ? ' held' : ''}${result.rules ? ' +rules' : ''}${input.persistent === false ? ' [not a kept conversation]' : ''}`);
    finish(result.text);
    return;
  }

  // Watch: wait for an urgent message without taking part in the conversation.
  const watchId = randomBytes(8).toString('hex');
  const maxMs = Number(option('--max-seconds', '14000')) * 1000;
  const intervalMs = Math.max(250, Number(option('--interval-ms', '3000')));
  const started = Date.now();
  let fresh = true;
  note(`watching as ${watchId}`);
  while (Date.now() - started < maxMs) {
    const result = await ask({ event, watch_id: watchId, fresh });
    if (result.refused !== undefined) {
      note(`watch ended: refused (${result.refused})`);
      return;
    }
    if (result.unreachable === undefined) {
      fresh = false;
      if (result.superseded) {
        note(`watch ${watchId} ended: another one took over`);
        return;
      }
      if (result.count > 0) {
        note(`watch ${watchId} woke the model with ${result.count} urgent`);
        finish(result.text);
        return;
      }
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  note(`watch ${watchId} ended: time is up`);
}

// Only when run as a program; the functions above are also imported by tests.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    // Last line of defence: a hook that throws must still not disturb the client.
    process.stderr.write(`acm hook: ${error.message}\n`);
    process.exitCode = 0;
  });
}
