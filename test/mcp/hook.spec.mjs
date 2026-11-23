// Test for the client hook program (src/mcp/hook.mjs) and the urgent routes
// against the real service: what each desktop client's hook prints, that a hook
// never disturbs its client when something is missing, that an idle
// conversation is woken through the watcher, and that an idle Codex thread is
// handed to Codex's own command.
//
// Run: node --test test/mcp/hook.spec.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-hook-${runId}-`));
const dataDir = join(base, 'data');
const queuedFile = join(base, 'queued.json');
const failMarker = join(base, 'fail-next');
const standIn = join(base, 'codex-stand-in.mjs');
// Stands in for "codex queue": records what it was given, fails when told to.
writeFileSync(standIn, [
  "import { existsSync, rmSync, writeFileSync } from 'node:fs';",
  `if (existsSync(${JSON.stringify(failMarker)})) { rmSync(${JSON.stringify(failMarker)}); console.error('thread is not known to the daemon'); process.exit(3); }`,
  `writeFileSync(${JSON.stringify(queuedFile)}, JSON.stringify(process.argv.slice(2)));`,
  "console.log('queued');",
].join('\n'));
process.env.ACM_DISPATCH_INTERVAL_MS = '250';
process.env.ACM_DISPATCH_COMMANDS = JSON.stringify({ codex: [process.execPath, standIn] });

const evidence = { runId, startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (id, detail) => evidence.checks.push({ id, ...detail });
let service;
let instance;
let lobby;
const sessions = {};
let key = 0;

async function cli(client, ...args) {
  const argv = [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args];
  const { stdout } = await promisify(execFile)(process.execPath, argv);
  return JSON.parse(stdout).result;
}
// An urgent message interrupts whom it names: in these tests, the other sessions as such.
const others = (client) => Object.entries(sessions).filter(([name]) => name !== client).map(([, id]) => id);
const say = (client, body, extra = {}) =>
  cli(client, 'call', 'send_message', '--json', JSON.stringify({ conversation_id: lobby, body, idempotency_key: `k${++key}`, ...(extra.urgent ? { recipient_session_ids: others(client) } : {}), ...extra }));

/** Runs the hook as a client would: input on stdin, resolves to {code, stdout, stderr}. */
function hook(client, event, input, extra = [], coreArgs = instance) {
  return new Promise((done, fail) => {
    const hookArgs = coreArgs.filter((value, index, all) => value !== '--mcp-port' && all[index - 1] !== '--mcp-port');
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', client, '--event', event, ...hookArgs, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', fail);
    child.once('exit', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
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
const hooksOf = async (client) => (await service.admin('GET', '/api/v1/bootstrap')).client_hooks.find((entry) => entry.session_id === sessions[client]);

describe('client hooks and urgent delivery', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
  });

  after(async () => {
    evidence.finalExitCode = await service.stop();
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(join(repoRoot, 'test-output', 'reports'), { recursive: true });
    writeFileSync(join(repoRoot, 'test-output', 'reports', 'mcp-hooks.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('adds nothing and never fails when there is no session or no service', async () => {
    // No client has used the acm tools yet: there is no identity to ask with.
    assert.deepEqual(await hook('claude', 'prompt', { session_id: 's1', prompt: 'hi' }), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await hook('codex', 'stop', { session_id: 't1' }), { code: 0, stdout: '', stderr: '' });
    // Antigravity expects a JSON object even when there is nothing to say.
    assert.deepEqual(await hook('antigravity', 'prompt', { conversationId: 'c1' }), { code: 0, stdout: '{}', stderr: '' });
    assert.equal((await hook('claude', 'watch', undefined, ['--max-seconds', '1'])).code, 0);

    for (const client of ['claude', 'codex', 'antigravity']) {
      const who = await cli(client, 'call', 'get_session');
      sessions[client] = who.session_id;
      lobby = who.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    }
    // The service is not where the hook looks: still nothing, still exit code 0, and quickly.
    const started = Date.now();
    const away = await hook('claude', 'prompt', { session_id: 's1' }, [], ['--data-dir', dataDir, '--core-port', String(await freePort())]);
    assert.deepEqual(away, { code: 0, stdout: '', stderr: '' });
    assert.ok(Date.now() - started < 5000, 'a hook must not hold up its client');
    // No input at all, and input that is not JSON, are both fine.
    assert.equal((await hook('claude', 'prompt', undefined)).code, 0);
    // A client that never closes the hook's input must not be left with a hanging process.
    const open = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', 'claude', '--event', 'prompt', '--data-dir', dataDir, '--core-port', instance[3]], { stdio: ['pipe', 'pipe', 'pipe'] });
    const ended = await Promise.race([new Promise((done) => open.once('exit', (code) => done(code))), sleep(6000).then(() => 'still running')]);
    open.kill();
    assert.equal(ended, 0, 'the hook ends by itself when its input stays open');
    // A wrong command line is reported on stderr without failing the client.
    const wrong = await hook('claude', 'bogus', {});
    assert.equal(wrong.code, 0);
    assert.match(wrong.stderr, /usage: hook\.mjs/);
    assert.match(readFileSync(join(dataDir, 'logs', 'hooks.log'), 'utf8'), /claude prompt no identity yet/);
    note('hook-fails-open', { noIdentity: 'nothing', serviceAway: 'nothing', exitCode: 0 });
  });

  it("puts unread messages into each client's conversation in that client's own format", async () => {
    const body = '构建完成：3 个警告。\n"quotes" & <tags> stay as they are';
    await say('codex', body);
    await say('antigravity', 'schema changed', { urgent: true });

    const claude = await hook('claude', 'prompt', { session_id: 'claude-conv-1', cwd: 'C:\\work\\repo', hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    assert.equal(claude.code, 0);
    const added = JSON.parse(claude.stdout).hookSpecificOutput;
    assert.equal(added.hookEventName, 'UserPromptSubmit');
    assert.ok(added.additionalContext.includes(body), 'the text arrives unchanged, Chinese included');
    assert.match(added.additionalContext, /^\[ACM\] 2 new message\(s\) from other sessions on this machine, 1 of them urgent\./);
    assert.match(added.additionalContext, /\[URGENT\] Antigravity/);
    assert.match(added.additionalContext, /not by the person typing/);
    // Shown once: the next prompt adds nothing.
    assert.equal((await hook('claude', 'prompt', { session_id: 'claude-conv-1' })).stdout, '');
    // Shown is not read: check_in still returns both.
    const caught = (await cli('claude', 'call', 'check_in')).conversations.find((entry) => entry.kind === 'lobby').new_messages;
    assert.deepEqual(caught.map((message) => [message.body, message.urgent === true]), [[body, false], ['schema changed', true]]);

    // A session start uses the other event name; Codex shares the contract.
    await say('claude', 'claude says hi');
    const codex = JSON.parse((await hook('codex', 'start', { session_id: 'thread-9', cwd: 'C:\\work', source: 'startup' })).stdout).hookSpecificOutput;
    assert.equal(codex.hookEventName, 'SessionStart');
    assert.match(codex.additionalContext, /schema changed/);
    assert.match(codex.additionalContext, /claude says hi/);
    assert.ok(!codex.additionalContext.includes(body), 'what a session wrote itself is not played back to it');

    // Antigravity: a system step before the model is called.
    const agy = JSON.parse((await hook('antigravity', 'prompt', { conversationId: 'agy-conv-3', workspacePaths: ['C:\\work\\agy'], lastUserInput: 'hi' })).stdout);
    assert.deepEqual(Object.keys(agy), ['injectSteps']);
    assert.ok(agy.injectSteps[0].systemMessage.systemMessage.includes(body));
    assert.equal((await hook('antigravity', 'prompt', { conversationId: 'agy-conv-3' })).stdout, '{}');

    // The console sees that each client ran its hook, and where, but not the client's own id.
    const seen = await hooksOf('antigravity');
    assert.equal(seen.client, 'antigravity');
    assert.equal(seen.event, 'prompt');
    assert.equal(seen.knows_conversation, true);
    assert.equal(seen.cwd, 'C:\\work\\agy');
    assert.equal(seen.runs, 2);
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/bootstrap')).includes('agy-conv-3'));
    note('hook-formats', { claude: 'hookSpecificOutput.additionalContext', codex: 'hookSpecificOutput.additionalContext', antigravity: 'injectSteps[].systemMessage', nonAsciiIntact: true, shownOnce: true, notMarkedRead: true });
  });

  it('continues a finished turn only for urgent messages', async () => {
    await say('claude', 'fyi only');
    assert.equal((await hook('codex', 'stop', { session_id: 'thread-9', stop_hook_active: false })).stdout, '');
    assert.equal((await hook('antigravity', 'stop', { conversationId: 'agy-conv-3', fullyIdle: true })).stdout, '{}');

    await say('claude', 'stop the rollout now', { urgent: true });
    const codex = JSON.parse((await hook('codex', 'stop', { session_id: 'thread-9' })).stdout);
    assert.equal(codex.decision, 'block');
    assert.match(codex.reason, /^\[ACM\] Urgent: 1 message\(s\) marked urgent/);
    assert.match(codex.reason, /stop the rollout now/);
    assert.ok(!codex.reason.includes('fyi only'));
    const agy = JSON.parse((await hook('antigravity', 'stop', { conversationId: 'agy-conv-3' })).stdout);
    assert.equal(agy.decision, 'continue');
    assert.match(agy.reason, /stop the rollout now/);
    // The continued turn ends: nothing new, so it stops.
    assert.equal((await hook('codex', 'stop', { session_id: 'thread-9', stop_hook_active: true })).stdout, '');
    assert.equal((await hooksOf('codex')).last_urgent.route, 'stop');
    note('urgent-at-turn-end', { codex: 'decision block + reason', antigravity: 'decision continue + reason', ordinaryMessageDoesNotContinue: true });
  });

  it('wakes an idle conversation through the watcher', async () => {
    await hook('claude', 'stop', { session_id: 'claude-conv-1' });
    const first = hook('claude', 'watch', { session_id: 'claude-conv-1' }, ['--interval-ms', '250', '--max-seconds', '30']);
    await waitFor(async () => (await hooksOf('claude')).watch_seen_at !== null, 5000, 'the watcher to register');
    // A second watcher of the same conversation replaces the first, which ends quietly.
    const second = hook('claude', 'watch', { session_id: 'claude-conv-1' }, ['--interval-ms', '250', '--max-seconds', '30']);
    assert.deepEqual(await first, { code: 0, stdout: '', stderr: '' });

    await say('codex', 'not urgent, no wake');
    await sleep(800);
    await say('codex', 'the build server is on fire', { urgent: true });
    const woken = await second;
    // Exit code 2 with the text on stderr is what wakes the model.
    assert.equal(woken.code, 2);
    assert.equal(woken.stdout, '');
    assert.match(woken.stderr, /the build server is on fire/);
    assert.ok(!woken.stderr.includes('not urgent, no wake'));
    assert.equal((await hooksOf('claude')).last_urgent.route, 'watch');
    note('watcher', { supersededEndsQuietly: true, wakeExitCode: 2, textOn: 'stderr' });
  });

  it("hands an idle Codex thread to Codex's own command, and only that client", async () => {
    await hook('codex', 'stop', { session_id: 'thread-9', cwd: base });
    await hook('antigravity', 'stop', { conversationId: 'agy-conv-3' });
    await say('claude', 'codex and antigravity: answer now', { urgent: true });
    await waitFor(() => existsSync(queuedFile), 15000, 'the command to be started');
    const [thread, text] = JSON.parse(readFileSync(queuedFile, 'utf8'));
    assert.equal(thread, 'thread-9');
    assert.match(text, /^\[ACM\] Urgent: 1 message\(s\)/);
    assert.match(text, /codex and antigravity: answer now/);
    assert.match(text, /started by ACM while the conversation was idle/);
    await waitFor(async () => (await hooksOf('codex')).last_urgent.status === 'ok', 5000, 'the outcome to be recorded');
    const state = await service.admin('GET', '/api/v1/bootstrap');
    assert.deepEqual(state.dispatch_clients, ['codex']);
    assert.equal((await hooksOf('codex')).last_urgent.route, 'command');
    // Antigravity has no such command: nothing was started for it, the message waits for its next prompt.
    assert.notEqual((await hooksOf('antigravity')).last_urgent.route, 'command');
    assert.match(JSON.parse((await hook('antigravity', 'prompt', { conversationId: 'agy-conv-3' })).stdout).injectSteps[0].systemMessage.systemMessage, /answer now/);

    // The operator can switch the idle route off per session.
    await service.admin('PUT', `/api/v1/sessions/${sessions.codex}`, { urgent_dispatch: false });
    await rm(queuedFile);
    await hook('codex', 'stop', { session_id: 'thread-9' });
    await say('claude', 'second urgent call', { urgent: true });
    await sleep(7000);
    assert.equal(existsSync(queuedFile), false);

    // Switched on again, a failing command is recorded with what it said.
    writeFileSync(failMarker, '1');
    await service.admin('PUT', `/api/v1/sessions/${sessions.codex}`, { urgent_dispatch: true });
    // Two starts for one session are kept apart, so this one waits for that distance.
    await waitFor(async () => (await hooksOf('codex')).last_urgent.status === 'failed', 45000, 'the failure to be recorded');
    assert.match((await hooksOf('codex')).last_urgent.detail, /exit code 3: thread is not known to the daemon/);
    // Not lost: the next prompt in that thread shows it.
    assert.match(JSON.parse((await hook('codex', 'prompt', { session_id: 'thread-9' })).stdout).hookSpecificOutput.additionalContext, /second urgent call/);
    note('idle-command', { command: 'stand-in for codex queue', arguments: ['<thread id>', '<text>'], onlyClientsWithCommand: true, switchPerSession: true, failureRecorded: true });
  });

  it('does not take a thread Codex keeps no record of for a window', async () => {
    // Codex runs its hooks for helper threads too; its input says where a thread's record is kept.
    const record = join(base, 'rollout-kept.jsonl');
    writeFileSync(record, '');
    const before = (await hooksOf('codex')).windows.length;
    await hook('codex', 'start', { session_id: 'thread-kept', transcript_path: record });
    await hook('codex', 'start', { session_id: 'thread-helper', transcript_path: null });
    await hook('codex', 'stop', { session_id: 'thread-gone', transcript_path: join(base, 'never-written.jsonl') });
    assert.equal((await hooksOf('codex')).windows.length, before + 1, 'only the thread with a record is a window');
    assert.match(readFileSync(join(dataDir, 'logs', 'hooks.log'), 'utf8'), /codex start shown \d+.* \[not a kept conversation\]/);
    note('helper-threads', { withRecord: 'a window', withoutRecord: 'not addressed, not woken' });
  });

  it('carries an urgent message into a turn that is under way, after its next tool call', async () => {
    const tool = () => hook('codex', 'tool', { session_id: 'thread-9', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await hook('codex', 'prompt', { session_id: 'thread-9' });
    // Nothing urgent: a tool call adds nothing and costs nothing.
    assert.deepEqual(await tool(), { code: 0, stdout: '', stderr: '' });
    await say('claude', 'halt: wrong branch', { urgent: true });
    // The turn does not have to end, and nobody has to steer it: the next tool call carries the message.
    const mid = JSON.parse((await tool()).stdout).hookSpecificOutput;
    assert.equal(mid.hookEventName, 'PostToolUse');
    assert.match(mid.additionalContext, /^\[ACM\] Urgent: 1 message\(s\) marked urgent/);
    assert.match(mid.additionalContext, /halt: wrong branch/);
    // Once: not with later tool calls, and not again when the turn ends.
    assert.equal((await tool()).stdout, '');
    assert.equal((await hook('codex', 'stop', { session_id: 'thread-9' })).stdout, '');
    assert.equal((await hooksOf('codex')).last_urgent.route, 'tool');
    note('urgent-in-turn', { codex: 'PostToolUse hookSpecificOutput.additionalContext', once: true });
  });

  it('caps how many messages a session may mark urgent', async () => {
    // Codex marked one message urgent earlier in this run; the second is its last.
    await service.admin('PUT', '/api/v1/settings', { urgent_per_hour: 2, message_rate_per_minute: 0 });
    assert.equal((await say('codex', 'first urgent', { urgent: true })).urgent, true);
    const second = await say('codex', 'second urgent', { urgent: true });
    assert.equal(second.urgent, false);
    assert.equal(second.urgent_downgraded, true);
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.urgent_per_hour, 2);
    note('urgent-cap', { perHour: 2, pastTheCap: 'sent as an ordinary message' });
  });
});
