// Test for windows against the real service and the real bridge: the single
// conversations of an application are told apart, named, addressed and woken
// one by one, and two conversations of the same application hear each other.
//
// Run: node --test test/mcp/window.spec.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-window-${runId}-`));
const dataDir = join(base, 'data');
const queuedFile = join(base, 'queued.jsonl');
const standIn = join(base, 'codex-stand-in.mjs');
// Stands in for "codex queue": one line per conversation it was asked to add a message to.
writeFileSync(standIn, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(queuedFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
process.env.ACM_DISPATCH_INTERVAL_MS = '250';
process.env.ACM_DISPATCH_COMMANDS = JSON.stringify({ codex: [process.execPath, standIn] });

let service;
let instance;
let codex;
let claude;
let lobby;
let key = 0;
const open = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, timeoutMs, what) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await check()) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** An application's bridge, started the way its client starts it. */
async function bridge(client, env = {}) {
  const sdk = new Client({ name: `${client}-stand-in`, version: '0.0.1' });
  await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', client, ...instance, '--no-autostart'], env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' }));
  open.push(sdk);
  return sdk;
}
/** One tool call; `meta` is what the client says about the conversation it comes from. */
async function call(sdk, name, args = {}, meta = undefined) {
  const response = await sdk.callTool({ name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
  return response.isError ? { ok: false, error: response.structuredContent.error } : { ok: true, result: response.structuredContent };
}
// Codex names the thread with every call.
const hy = { threadId: 'thread-hy', 'x-codex-turn-metadata': { thread_id: 'thread-hy', thread_source: 'user' } };
const nbs = { 'x-codex-turn-metadata': { thread_id: 'thread-nbs', thread_source: 'user' } };
/** Runs the hook program as the client would for one conversation. */
function hook(client, event, input) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', client, '--event', event, '--data-dir', dataDir, '--core-port', instance[3]], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.once('error', fail);
    child.once('exit', () => done(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const queued = () => (existsSync(queuedFile) ? readFileSync(queuedFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

describe('windows', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    codex = await bridge('codex');
    // Claude starts one bridge per conversation and names the conversation in its environment.
    claude = await bridge('claude', { CLAUDE_CODE_SESSION_ID: 'conv-lead' });
  });

  after(async () => {
    for (const sdk of open) {
      await sdk.close().catch(() => undefined);
    }
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('tells the conversations of one application apart and lets each name itself', async () => {
    assert.equal((await codex.listTools()).tools.length, 24);
    const first = (await call(codex, 'check_in', {}, hy)).result;
    const second = (await call(codex, 'check_in', {}, nbs)).result;
    lobby = first.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    assert.match(first.window.name, /^codex-[0-9a-f]{4}$/);
    assert.notEqual(first.window.window_id, second.window.window_id);
    assert.equal((await call(codex, 'check_in', {}, hy)).result.window.window_id, first.window.window_id);

    assert.equal((await call(codex, 'name_window', { name: 'hy' }, hy)).result.name, 'hy');
    assert.equal((await call(codex, 'name_window', { name: 'nbs' }, nbs)).result.name, 'nbs');
    const taken = await call(codex, 'name_window', { name: 'HY' }, nbs);
    assert.equal(taken.error.code, 'NAME_TAKEN');
    // A call that does not say which conversation it comes from has no window to name.
    const unknown = await call(codex, 'name_window', { name: 'nobody' });
    assert.equal(unknown.error.code, 'WINDOW_UNKNOWN');

    // The other application sees both, by name, and which of them it is itself.
    const seen = (await call(claude, 'check_in')).result;
    assert.match(seen.window.name, /^claude-/);
    const theirs = seen.project_sessions.find((entry) => entry.display_name === 'Codex').windows;
    assert.deepEqual(theirs.map((entry) => entry.name).sort(), ['hy', 'nbs']);
    assert.ok(theirs.every((entry) => ['idle', 'busy', 'watching'].includes(entry.state) && entry.is_you === false));
    assert.deepEqual(seen.project_sessions.find((entry) => entry.is_you).windows.map((entry) => entry.is_you), [true]);
  });

  it('puts a message in front of the window it is meant for, and no other', async () => {
    const sent = await call(claude, 'send_message', { conversation_id: lobby, body: 'hy: start the G4 run and report back', to_windows: ['hy'], idempotency_key: `k${++key}` });
    assert.deepEqual(sent.result.to_windows.map((entry) => entry.name), ['hy']);
    assert.match(sent.result.from_window.name, /^claude-/);
    const forHy = JSON.parse(await hook('codex', 'prompt', { session_id: 'thread-hy' })).hookSpecificOutput.additionalContext;
    assert.match(forHy, /hy: start the G4 run/);
    assert.match(forHy, /addressed to this window/);
    assert.match(forHy, /This conversation is window "hy"/);
    assert.equal(await hook('codex', 'prompt', { session_id: 'thread-nbs' }), '');

    const wrong = await call(claude, 'send_message', { conversation_id: lobby, body: 'x', to_windows: ['nobody'], idempotency_key: `k${++key}` });
    assert.equal(wrong.error.code, 'UNKNOWN_WINDOW');
    assert.deepEqual(wrong.error.details.windows.filter((name) => ['hy', 'nbs'].includes(name)), ['hy', 'nbs']);
    // A direct message names a window of that session, not of another.
    const sessions = (await call(claude, 'check_in')).result.project_sessions;
    const me = sessions.find((entry) => entry.is_you);
    const misdirected = await call(codex, 'direct_message', { to_session_id: me.session_id, body: 'x', to_windows: ['nbs'], idempotency_key: `k${++key}` }, hy);
    assert.equal(misdirected.error.code, 'INVALID_RECIPIENT');
  });

  it('lets two conversations of one application hear each other and read on their own', async () => {
    await call(codex, 'check_in', {}, hy);
    await call(codex, 'check_in', {}, nbs);
    await call(codex, 'send_message', { conversation_id: lobby, body: '[hy] G4 is running', idempotency_key: `k${++key}` }, hy);
    await call(claude, 'send_message', { conversation_id: lobby, body: 'noted', idempotency_key: `k${++key}` });

    const sibling = (await call(codex, 'check_in', {}, nbs)).result.conversations.find((entry) => entry.kind === 'lobby').new_messages;
    assert.deepEqual(sibling.map((message) => [message.body, message.from_window?.name ?? null]), [['[hy] G4 is running', 'hy'], ['noted', sibling[1].from_window.name]]);
    const author = (await call(codex, 'check_in', {}, hy)).result.conversations.find((entry) => entry.kind === 'lobby').new_messages;
    assert.deepEqual(author.map((message) => message.body), ['noted']);
    // The hook of the sibling shows it too; the author's own hook does not.
    await call(codex, 'send_message', { conversation_id: lobby, body: '[nbs] audit passed', idempotency_key: `k${++key}` }, nbs);
    assert.match(JSON.parse(await hook('codex', 'prompt', { session_id: 'thread-hy' })).hookSpecificOutput.additionalContext, /Codex window "nbs"[\s\S]*\[nbs\] audit passed/);
    assert.equal(await hook('codex', 'prompt', { session_id: 'thread-nbs' }), '');
  });

  it('wakes exactly the idle conversation an urgent message names', async () => {
    // Both conversations end their turn and sit idle.
    await hook('codex', 'stop', { session_id: 'thread-hy' });
    await hook('codex', 'stop', { session_id: 'thread-nbs' });
    await call(claude, 'send_message', { conversation_id: lobby, body: 'nbs: resume the audit now', urgent: true, to_windows: ['nbs'], idempotency_key: `k${++key}` });
    await waitFor(() => queued().length === 1, 15000, 'the named conversation to be handed its message');
    const [thread, text] = queued()[0];
    assert.equal(thread, 'thread-nbs');
    assert.match(text, /nbs: resume the audit now/);
    assert.match(text, /This conversation is window "nbs"/);
    await sleep(1500);
    assert.equal(queued().length, 1, 'the other conversation is left alone');

    // Meant for nobody in particular: nobody is interrupted, and the sender is told so.
    const loose = await call(claude, 'send_message', { conversation_id: lobby, body: 'all windows: report status', urgent: true, idempotency_key: `k${++key}` });
    assert.match(loose.result.urgent_note, /interrupts nobody/);
    // Naming both: each is handed it, once.
    await sleep(31000);
    assert.equal(queued().length, 1, 'the message to everybody started nothing');
    await call(claude, 'send_message', { conversation_id: lobby, body: 'hy and nbs: report status', urgent: true, to_windows: ['hy', 'nbs'], idempotency_key: `k${++key}` });
    await waitFor(() => queued().length === 3, 20000, 'both conversations to be handed the message');
    assert.deepEqual(queued().slice(1).map(([conversation]) => conversation).sort(), ['thread-hy', 'thread-nbs']);
    assert.ok(queued().slice(1).every(([, text]) => !text.includes('all windows: report status')));

    // The console sees the windows of each application and can rename one.
    const state = await service.admin('GET', '/api/v1/bootstrap');
    const entry = state.client_hooks.find((hooks) => hooks.client === 'codex');
    assert.deepEqual(entry.windows.map((window) => window.name).sort(), ['hy', 'nbs']);
    assert.equal(entry.last_urgent.route, 'command');
    assert.ok(!JSON.stringify(state).includes('thread-hy'), "a client's own conversation ids stay in the store");
    const renamed = await service.admin('PUT', `/api/v1/windows/${entry.windows.find((window) => window.name === 'hy').window_id}`, { name: 'hybrid' });
    assert.equal(renamed.name, 'hybrid');
    assert.equal((await call(codex, 'check_in', {}, hy)).result.window.name, 'hybrid');
    assert.equal(state.tool_contract, 7);
  });
});
