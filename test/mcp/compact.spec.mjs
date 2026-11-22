// Test for compacting a conversation, end to end: a coordinating session writes
// a digest and says which messages stay in front of readers and which do not; a
// reader that is behind is then given little, through its tools and through its
// client's hooks. The operator can do the same, and can keep it to the console.
//
// Run: node --test test/mcp/compact.spec.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-compact-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;
let lobby;
let key = 0;

/** One tool call through the command line entry; resolves to {result} or {error}. */
async function call(client, tool, args = {}) {
  const argv = [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', 'call', tool, '--json', JSON.stringify(args)];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, argv, { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (failure) {
    return JSON.parse(failure.stdout);
  }
}
function hook(client, event, input) {
  return new Promise((done, fail) => {
    const args = instance.filter((value, index, all) => value !== '--mcp-port' && all[index - 1] !== '--mcp-port');
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', client, '--event', event, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.once('error', fail);
    child.once('exit', () => done(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const say = (client, body) => call(client, 'send_message', { conversation_id: lobby, body, idempotency_key: `k${++key}` });

describe('compacting a conversation', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    await service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: 0, message_rate_per_hour: 0, duplicate_window_seconds: 0 });
    for (const client of ['claude', 'codex']) {
      lobby = (await call(client, 'get_session')).result.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    }
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('gives a reader that is behind the digest and what was kept, not the history', async () => {
    for (let index = 1; index <= 24; index += 1) {
      await say('claude', index === 2 ? 'SPEC: all tables in UTC' : index === 4 ? 'scratch, ignore this' : `status ${index}`);
    }
    const done = await call('claude', 'compact_conversation', { conversation_id: lobby, summary: 'DIGEST: 24 status lines, all green; table spec is in message 2.', keep: [2], drop: [4] });
    assert.equal(done.ok, true);
    assert.equal(done.result.digest.upto_seq, 24);
    assert.equal(done.result.kept_messages, 1);
    assert.equal(done.result.dropped_messages, 1);
    await say('claude', 'status 25');

    // Through its client's hook: the digest, the kept message, the one new message. No history, no scratch.
    const shown = JSON.parse(await hook('codex', 'prompt', { session_id: 'thread-1', hook_event_name: 'UserPromptSubmit' })).hookSpecificOutput.additionalContext;
    assert.match(shown, /Digest of the lobby up to message 24/);
    assert.match(shown, /DIGEST: 24 status lines, all green/);
    assert.match(shown, /SPEC: all tables in UTC/);
    assert.match(shown, /status 25/);
    assert.ok(!shown.includes('status 7') && !shown.includes('scratch, ignore this'));
    assert.ok(shown.length < 2500, `the whole of it is short (${shown.length} characters)`);

    // Through check_in: the same, as data.
    const mine = (await call('codex', 'check_in')).result.conversations.find((entry) => entry.kind === 'lobby');
    assert.equal(mine.digest.text, 'DIGEST: 24 status lines, all green; table spec is in message 2.');
    assert.deepEqual(mine.new_messages.map((message) => message.body), ['status 25']);
    assert.deepEqual(mine.kept_messages.map((message) => [message.sequence, message.context]), [[2, 'kept']]);
    // read_messages still has everything, marked.
    const history = (await call('codex', 'read_messages', { conversation_id: lobby, after_seq: 0, limit: 5 })).result.messages;
    assert.deepEqual(history.map((message) => message.context), [null, 'kept', null, 'dropped', null]);
  });

  it('tells the member who wrote most when a digest is due, and nobody else', async () => {
    for (let index = 26; index <= 86; index += 1) {
      await say('claude', `status ${index}`);
    }
    const lobbyOf = async (client) => (await call(client, 'check_in')).result.conversations.find((entry) => entry.kind === 'lobby');
    assert.equal((await lobbyOf('claude')).digest_due, true);
    const reader = await lobbyOf('codex');
    assert.equal(reader.digest_due, undefined);
    // Far behind again, and no digest for it yet: the newest messages, and how many were left out.
    assert.equal(reader.new_messages.length, 15);
    assert.equal(reader.skipped_earlier, 46);
    await call('claude', 'compact_conversation', { conversation_id: lobby, summary: 'DIGEST 2: 86 status lines.' });
    assert.equal((await lobbyOf('claude')).digest_due, undefined);
  });

  it('compacts the board as well: settled tasks leave what every check_in carries', async () => {
    const long = 'detail '.repeat(200);
    const made = [];
    for (const title of ['rerun table 4', 'draft figure 2', 'archive the raw files']) {
      made.push((await call('claude', 'create_task', { conversation_id: lobby, title, detail: long })).result);
    }
    const before = (await call('codex', 'check_in')).result.conversations.find((entry) => entry.kind === 'lobby').tasks;
    assert.equal(before.length, 3);
    // An overview: enough to see where the work stands, not the full text of every task.
    assert.ok(before.every((task) => task.detail.length < 260 && task.conversation_id === undefined && typeof task.version === 'number'));
    // The coordinator closes what is settled, by board number or by id, in the same call that compacts.
    const done = await call('claude', 'compact_conversation', { conversation_id: lobby, close_tasks: [made[0].number, made[1].task_id] });
    assert.equal(done.ok, true);
    assert.equal(done.result.closed_tasks, 2);
    assert.equal(done.result.open_tasks, 1);
    const after = (await call('codex', 'check_in')).result.conversations.find((entry) => entry.kind === 'lobby').tasks;
    assert.deepEqual(after.map((task) => task.title), ['archive the raw files']);
    // They are closed, not gone: the full board still has them, with who closed them.
    const board = (await call('codex', 'list_tasks', { conversation_id: lobby, include_closed: true })).result.tasks;
    assert.equal(board.filter((task) => task.status === 'done').length, 2);
    assert.match(board.find((task) => task.title === 'rerun table 4').note, /while compacting/);
    assert.equal((await call('claude', 'compact_conversation', { conversation_id: lobby, close_tasks: [999] })).error.code, 'NOT_FOUND');
  });

  it('keeps archived conversations and compacted messages out of every context', async () => {
    const ids = {};
    for (const client of ['claude', 'codex']) {
      ids[client] = (await call(client, 'get_session')).result.session_id;
    }
    const project = (await call('claude', 'get_session')).result.project_id;
    const side = await service.admin('POST', '/api/v1/conversations', { project_id: project, task_code: 'OLD-1', title: 'Finished side project' });
    await service.admin('PUT', `/api/v1/conversations/${side.conversation_id}/members`, { expected_version: 1, members: [{ session_id: ids.claude }, { session_id: ids.codex }] });
    await call('claude', 'send_message', { conversation_id: side.conversation_id, body: 'ARCHIVED-TALK: old result', idempotency_key: `k${++key}` });
    await call('claude', 'send_message', { conversation_id: side.conversation_id, body: 'ARCHIVED-ASK: please confirm', recipient_session_ids: [ids.codex], idempotency_key: `k${++key}` });
    // A request in the lobby that is then resolved: nobody has to answer it any more.
    const asked = await call('claude', 'send_message', { conversation_id: lobby, body: 'SETTLED-ASK: please confirm', recipient_session_ids: [ids.codex], idempotency_key: `k${++key}` });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    // Both count among what Codex has not acknowledged yet.
    const waiting = (await call('codex', 'check_in')).result.unacknowledged;
    await call('claude', 'compact_conversation', { conversation_id: lobby, resolve: [asked.result.sequence] });
    await service.admin('PUT', `/api/v1/conversations/${side.conversation_id}`, { archived: true });

    // Not in check_in, not in the inbox, not in the hook, for a window that never saw any of it.
    const checked = (await call('codex', 'check_in')).result;
    assert.ok(!JSON.stringify(checked).includes('ARCHIVED-') && !JSON.stringify(checked).includes('SETTLED-ASK'));
    assert.ok(!checked.conversations.some((entry) => entry.conversation_id === side.conversation_id));
    assert.equal(checked.unacknowledged, waiting - 3, 'the resolved request and the two messages of the archived conversation wait for nobody');
    const inbox = JSON.stringify((await call('codex', 'get_inbox', { limit: 200 })).result.items);
    assert.ok(!inbox.includes('ARCHIVED-') && !inbox.includes('SETTLED-ASK'));
    const shown = await hook('codex', 'prompt', { session_id: 'thread-new', hook_event_name: 'UserPromptSubmit' });
    assert.ok(!shown.includes('ARCHIVED-') && !shown.includes('SETTLED-ASK'));
    // Asking for it by name says why there is nothing.
    assert.equal((await call('codex', 'read_messages', { conversation_id: side.conversation_id })).error.code, 'CONVERSATION_ARCHIVED');
  });

  it('lets the operator compact too, and keep it to the console', async () => {
    const byOperator = await service.admin('POST', `/api/v1/conversations/${lobby}/compact`, { drop: [10, 11], keep: [12] });
    assert.equal(byOperator.dropped_messages, 3);
    assert.equal(byOperator.kept_messages, 2);
    // A coordinating session confirms what is settled as it goes: resolved messages leave everybody's context.
    const request = (await say('codex', 'REQUEST: rerun table 4')).result.sequence;
    const settled = await call('claude', 'compact_conversation', { conversation_id: lobby, resolve: [request] });
    assert.equal(settled.result.resolved_messages, 2, 'this one and the request resolved in the test before');
    const marked = (await call('claude', 'read_messages', { conversation_id: lobby, after_seq: request - 1, limit: 1 })).result.messages[0];
    assert.equal(marked.context, 'resolved');
    assert.equal((await service.admin('PUT', '/api/v1/settings', { agent_compact: false })).agent_compact, false);
    const refused = await call('claude', 'compact_conversation', { conversation_id: lobby, restore: [10] });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'COMPACT_DISABLED');
    await service.admin('PUT', '/api/v1/settings', { agent_compact: true });
    // The console shows the digest, how many messages were kept or taken out, and what was done when.
    const seen = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((entry) => entry.conversation_id === lobby);
    assert.equal(seen.digest.text, 'DIGEST 2: 86 status lines.');
    assert.deepEqual(Object.keys(seen.context_counts).sort(), ['dropped', 'kept', 'resolved']);
    assert.ok(seen.context_counts.dropped >= 3 && seen.context_counts.resolved >= 2);
    const log = (await service.admin('GET', `/api/v1/conversations/${lobby}/compactions`)).compactions;
    assert.ok(log.length >= 5, 'every act of compacting is on record');
    assert.equal(log.at(-1).by, 'claude-desktop');
    assert.equal(log.at(-1).upto_seq, 24);
    assert.ok(log.some((entry) => entry.by === 'the operator' && entry.dropped === 2 && entry.kept === 1));
    assert.ok(!JSON.stringify(log).includes('DIGEST'), 'the record holds no text of the conversation');
    assert.equal((await call('claude', 'compact_conversation', { conversation_id: lobby, restore: [10] })).result.dropped_messages, 2);
  });

  it('keeps every digest, and lets the operator put an earlier one back in use', async () => {
    const history = (await service.admin('GET', `/api/v1/conversations/${lobby}/digests`)).digests;
    assert.ok(history.length >= 2, 'the earlier digest was not overwritten');
    assert.equal(history[0].text, 'DIGEST 2: 86 status lines.');
    assert.equal(history.filter((entry) => entry.current).length, 1);
    assert.equal(history[0].current, true);
    const earlier = history.at(-1);
    assert.equal(earlier.by, 'claude-desktop');
    assert.equal(earlier.upto_seq, 24);

    const chosen = await service.admin('PUT', `/api/v1/conversations/${lobby}/digest`, { digest_id: earlier.digest_id });
    assert.equal(chosen.digest.text, earlier.text);
    assert.equal(chosen.digest.upto_seq, 24);
    assert.equal(chosen.digests.find((entry) => entry.current).digest_id, earlier.digest_id);
    // Readers get the one in use.
    const seen = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((entry) => entry.conversation_id === lobby);
    assert.equal(seen.digest.text, earlier.text);
    // Back to the newest; a digest of another conversation is not one of these.
    await service.admin('PUT', `/api/v1/conversations/${lobby}/digest`, { digest_id: history[0].digest_id });
    const other = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((entry) => entry.conversation_id !== lobby);
    await assert.rejects(service.admin('PUT', `/api/v1/conversations/${other.conversation_id}/digest`, { digest_id: history[0].digest_id }), { code: 'NOT_FOUND' });
  });

  it('counts activity for the console overview, without any text', async () => {
    const day = await service.admin('GET', '/api/v1/stats?days=1');
    assert.equal(day.bucket, 'hour');
    assert.ok(day.messages > 50, 'the messages of these tests');
    assert.equal(day.series.reduce((sum, entry) => sum + entry.messages, 0), day.messages);
    assert.match(day.series[0].at, /^\d{4}-\d\d-\d\dT\d\d$/);
    assert.ok(day.senders.some((entry) => entry.label === 'claude-desktop'));
    assert.ok(day.conversations.some((entry) => entry.conversation_id === lobby));
    // Who talks where, so that direct conversations can be told apart.
    assert.match(day.conversations.find((entry) => entry.conversation_id === lobby).members, /Claude/);
    assert.deepEqual(Object.keys(day.tasks).sort(), ['blocked', 'cancelled', 'doing', 'done', 'todo']);
    assert.ok(!JSON.stringify(day).includes('DIGEST') && !JSON.stringify(day).includes('status line'), 'counts only');
    const month = await service.admin('GET', '/api/v1/stats?days=30');
    assert.equal(month.bucket, 'day');
    assert.equal(month.messages, day.messages);
  });
});
