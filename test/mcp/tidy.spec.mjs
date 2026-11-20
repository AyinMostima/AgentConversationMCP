// Test for keeping the list of conversations tidy, against the real service:
// the operator renames, archives, clears and deletes through the HTTP API, and
// the sessions see exactly what follows from that.
//
// Run: node --test test/mcp/tidy.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-tidy-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;
let topic;
const sessions = {};
let key = 0;

/** Runs the command line as one client; resolves to {code, result, error}. */
async function cli(client, ...args) {
  const argv = [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args];
  try {
    return { code: 0, result: JSON.parse((await promisify(execFile)(process.execPath, argv)).stdout).result };
  } catch (failure) {
    return { code: failure.code, error: JSON.parse(failure.stdout).error };
  }
}
const say = (client, conversation, body, extra = {}) => cli(client, 'call', 'send_message', '--json', JSON.stringify({ conversation_id: conversation, body, idempotency_key: `k${++key}`, ...extra }));
const listed = async (client) => (await cli(client, 'call', 'list_conversations')).result.conversations.map((entry) => entry.conversation_id);

describe('tidying conversations', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    for (const client of ['claude', 'codex']) {
      sessions[client] = (await cli(client, 'call', 'get_session')).result.session_id;
    }
    topic = (await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_default', task_code: 'DATA-1', title: 'Clean the readings' })).conversation_id;
    await service.admin('PUT', `/api/v1/conversations/${topic}/members`, { expected_version: 1, members: Object.values(sessions).map((session_id) => ({ session_id, can_read: true, can_write: true })) });
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('renames a task conversation and shows how much is in each', async () => {
    await say('codex', topic, 'first finding');
    const renamed = await service.admin('PUT', `/api/v1/conversations/${topic}`, { title: 'Clean July', task_code: 'DATA-7', purpose: 'all of July' });
    assert.deepEqual([renamed.title, renamed.task_code, renamed.purpose, renamed.message_count], ['Clean July', 'DATA-7', 'all of July', 1]);
    assert.ok(typeof renamed.last_message_at === 'string');
    assert.equal((await cli('claude', 'call', 'list_conversations')).result.conversations.find((entry) => entry.conversation_id === topic).title, 'Clean July');
    const lobby = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((entry) => entry.kind === 'lobby');
    await assert.rejects(service.admin('PUT', `/api/v1/conversations/${lobby.conversation_id}`, { title: 'Hall' }), { code: 'INVALID_ARGUMENT', status: 400 });
    await assert.rejects(service.admin('PUT', `/api/v1/conversations/${topic}`, {}), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(service.admin('PUT', '/api/v1/conversations/cnv_missing', { title: 'x' }), { code: 'NOT_FOUND', status: 404 });
  });

  it('puts an archived conversation out of the sessions\' sight until it is restored', async () => {
    const archived = await service.admin('PUT', `/api/v1/conversations/${topic}`, { archived: true });
    assert.equal(archived.status, 'archived');
    assert.ok(!(await listed('claude')).includes(topic));
    assert.ok(!(await cli('claude', 'call', 'check_in')).result.conversations.some((entry) => entry.conversation_id === topic));
    const refused = await say('claude', topic, 'too late');
    assert.deepEqual([refused.code, refused.error.code], [1, 'CONVERSATION_ARCHIVED']);
    await assert.rejects(service.admin('POST', `/api/v1/conversations/${topic}/messages`, { body: 'operator too' }), { code: 'CONVERSATION_ARCHIVED', status: 409 });
    // The operator still has all of it.
    assert.equal((await service.admin('GET', `/api/v1/conversations/${topic}/messages`)).messages.length, 1);

    assert.equal((await service.admin('PUT', `/api/v1/conversations/${topic}`, { archived: false })).status, 'open');
    assert.ok((await listed('claude')).includes(topic));
    assert.equal((await say('claude', topic, 'back again')).code, 0);

    // The lobby stays; a direct conversation the operator archived comes back when one writes again.
    const lobby = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((entry) => entry.kind === 'lobby');
    await assert.rejects(service.admin('PUT', `/api/v1/conversations/${lobby.conversation_id}`, { archived: true }), { code: 'INVALID_ARGUMENT' });
    const direct = (await cli('claude', 'call', 'direct_message', '--json', JSON.stringify({ to_session_id: sessions.codex, body: 'between us', idempotency_key: `k${++key}` }))).result.conversation_id;
    await service.admin('PUT', `/api/v1/conversations/${direct}`, { archived: true });
    assert.ok(!(await listed('codex')).includes(direct));
    const again = await cli('codex', 'call', 'direct_message', '--json', JSON.stringify({ to_session_id: sessions.claude, body: 'still here', idempotency_key: `k${++key}` }));
    assert.equal(again.result.conversation_id, direct);
    assert.ok((await listed('claude')).includes(direct));
  });

  it('clears messages for good and keeps numbering and catching up intact', async () => {
    const before = await service.admin('GET', `/api/v1/conversations/${topic}`);
    assert.equal(before.message_count, 2);
    // Nothing is a week old yet.
    assert.equal((await service.admin('POST', `/api/v1/conversations/${topic}/clear`, { older_than_days: 7 })).deleted_messages, 0);
    const cleared = await service.admin('POST', `/api/v1/conversations/${topic}/clear`, {});
    assert.deepEqual([cleared.deleted_messages, cleared.message_count, cleared.last_message_at], [2, 0, null]);
    assert.deepEqual((await service.admin('GET', `/api/v1/conversations/${topic}/messages`)).messages, []);
    // A new message continues the numbering, and the other session catches up with exactly that one.
    assert.equal((await say('codex', topic, 'fresh start')).result.sequence, 3);
    const caught = (await cli('claude', 'call', 'check_in')).result.conversations.find((entry) => entry.conversation_id === topic);
    assert.deepEqual(caught.new_messages.map((message) => message.body), ['fresh start']);
    // What was deleted is in no event either.
    const events = await service.admin('GET', '/api/v1/events?after=0&limit=1000');
    const record = events.events.find((event) => event.event_type === 'conversation.cleared');
    assert.deepEqual(record.payload, { deleted_messages: 2, older_than_days: 0 });
    assert.ok(!JSON.stringify(events).includes('first finding'));
  });

  it('deletes a conversation with everything in it, and never the lobby', async () => {
    await cli('claude', 'call', 'create_task', '--json', JSON.stringify({ conversation_id: topic, title: 'follow up' }));
    const gone = await service.admin('DELETE', `/api/v1/conversations/${topic}`);
    assert.deepEqual([gone.deleted, gone.deleted_messages, gone.deleted_tasks], [true, 1, 1]);
    await assert.rejects(service.admin('GET', `/api/v1/conversations/${topic}`), { code: 'NOT_FOUND' });
    await assert.rejects(service.admin('DELETE', `/api/v1/conversations/${topic}`), { code: 'NOT_FOUND' });
    assert.ok(!(await listed('codex')).includes(topic));
    const refused = await say('codex', topic, 'anyone?');
    assert.equal(refused.error.code, 'NOT_MEMBER');
    const state = await service.admin('GET', '/api/v1/bootstrap');
    assert.ok(!state.conversations.some((entry) => entry.conversation_id === topic));
    const lobby = state.conversations.find((entry) => entry.kind === 'lobby');
    await assert.rejects(service.admin('DELETE', `/api/v1/conversations/${lobby.conversation_id}`), { code: 'INVALID_ARGUMENT' });
    // The task code is free again, and the sessions go on as before.
    await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_default', task_code: 'DATA-7', title: 'Second attempt' });
    assert.equal((await say('claude', lobby.conversation_id, 'still talking')).code, 0);
  });
});
