// Test for how much one read may hand a session. Text fills a reader's context,
// so every way of reading is bounded in bytes and not only in messages, and none
// of them starts with the oldest part of a conversation unless asked to.
//
// Run: node --test test/mcp/bounds.spec.mjs
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
const base = mkdtempSync(join(tmpdir(), `acm-bounds-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;
let lobby;
const ids = {};
let key = 0;

async function cli(client, ...args) {
  const run = promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args], { maxBuffer: 64 * 1024 * 1024 });
  const { stdout } = await run.catch((failure) => ({ stdout: failure.stdout }));
  return JSON.parse(stdout);
}
const call = async (client, tool, args = {}) => {
  const answer = await cli(client, 'call', tool, '--json', JSON.stringify(args));
  assert.ok(answer.ok, JSON.stringify(answer).slice(0, 300));
  return answer.result;
};
const refused = async (client, tool, args = {}) => (await cli(client, 'call', tool, '--json', JSON.stringify(args))).error;
const say = (client, body, extra = {}) => call(client, 'send_message', { conversation_id: lobby, body, idempotency_key: `b${++key}`, ...extra });
const direct = (from, to, body) => call(from, 'direct_message', { to_session_id: ids[to], body, idempotency_key: `b${++key}` });
const textOf = (messages) => messages.reduce((sum, message) => sum + (message.body ?? '').length, 0);

describe('how much one read hands a session', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    for (const client of ['claude', 'codex', 'grok']) {
      ids[client] = (await cli(client, 'call', 'get_session')).result.session_id;
    }
    await service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: 0, message_rate_per_hour: 0, duplicate_window_seconds: 0 });
    lobby = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((conversation) => conversation.kind === 'lobby').conversation_id;
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('gives one long message addressed to the reader up to a size, and the rest on request', async () => {
    const long = `SPEC ${'s'.repeat(20000)} END`;
    const sent = await direct('claude', 'grok', long);
    const checked = await call('grok', 'check_in');
    const shown = checked.conversations[0].new_messages[0];
    assert.equal(shown.message_id, sent.message_id);
    assert.equal(shown.cut, true);
    assert.ok(shown.body.length <= 4100, String(shown.body.length));
    // Exactly that message, whole, without anything around it.
    const whole = await call('grok', 'read_messages', { conversation_id: checked.conversations[0].conversation_id, message_ids: [sent.message_id] });
    assert.equal(whole.messages.length, 1);
    assert.equal(whole.messages[0].body, long);
    assert.equal(whole.by_message_ids, true);
    // Only what the reader may see, and a few at a time.
    assert.equal((await refused('codex', 'read_messages', { conversation_id: lobby, message_ids: [sent.message_id] })).code, 'NOT_FOUND');
    assert.equal((await refused('grok', 'read_messages', { conversation_id: checked.conversations[0].conversation_id, message_ids: Array.from({ length: 11 }, () => sent.message_id) })).code, 'INVALID_ARGUMENT');
    await call('grok', 'acknowledge_message', { message_id: sent.message_id });
  });

  it('keeps a whole check-in to a size however much was written', async () => {
    // Twelve long direct messages and a busy lobby: far more than fits.
    for (let index = 0; index < 12; index += 1) {
      await direct('claude', 'grok', `Direct ${index}: ${'d'.repeat(3500)}`);
    }
    for (let index = 0; index < 20; index += 1) {
      await say('claude', `Lobby ${index}: ${'l'.repeat(3000)}`);
    }
    const checked = await call('grok', 'check_in');
    const [mine, everybody] = checked.conversations;
    assert.deepEqual([mine.kind, everybody.kind], ['direct', 'lobby']);
    // The budget goes to what is for this reader, the newest first: the last ones are whole,
    // the earlier ones are overviews; what is for everybody is overviews throughout.
    assert.equal(mine.new_messages.at(-1).body.length, `Direct 11: `.length + 3500);
    assert.equal(mine.new_messages.at(-1).cut, undefined);
    assert.equal(mine.new_messages[0].cut, true);
    assert.ok(everybody.new_messages.every((message) => message.cut === true && message.body.length < 600));
    const text = textOf(mine.new_messages) + textOf(everybody.new_messages) + textOf(everybody.kept_messages ?? []);
    assert.ok(text <= 24000 + 27 * 600, String(text));
    // All of it, with the roster and the list of what waits for an answer.
    const size = JSON.stringify(checked).length;
    assert.ok(size < 70000, String(size));
    // What waits is listed within its own bound, and one reply settles it.
    assert.ok(textOf(checked.awaiting_your_reply.messages) < 9000);
    await direct('grok', 'claude', 'Read.');
  });

  it('reads the newest messages when no place is named, and the beginning only on request', async () => {
    for (let index = 0; index < 45; index += 1) {
      await say('codex', `Short ${index}.`);
    }
    const newest = await call('grok', 'read_messages', { conversation_id: lobby });
    assert.equal(newest.messages.at(-1).body, 'Short 44.');
    assert.equal(newest.messages.at(-1).sequence, newest.last_seq);
    assert.ok(newest.first_seq > 1, String(newest.first_seq));
    assert.equal(newest.messages[0].sequence, newest.first_seq);
    assert.equal(newest.has_more, false);
    // Named: from there on, oldest first, as before.
    const start = await call('grok', 'read_messages', { conversation_id: lobby, after_seq: 0, limit: 5 });
    assert.deepEqual(start.messages.map((message) => message.sequence), [1, 2, 3, 4, 5]);
    assert.equal(start.has_more, true);
  });

  it('ends a page early once it holds enough text', async () => {
    const from = (await call('grok', 'read_messages', { conversation_id: lobby, limit: 1 })).last_seq;
    for (let index = 0; index < 20; index += 1) {
      await say('codex', `Big ${index}: ${'b'.repeat(6000)}`);
    }
    const first = await call('grok', 'read_messages', { conversation_id: lobby, after_seq: from });
    assert.ok(first.messages.length < 20 && first.messages.length >= 7, String(first.messages.length));
    assert.ok(textOf(first.messages) <= 48000 + 100, String(textOf(first.messages)));
    assert.equal(first.has_more, true);
    assert.equal(first.messages[0].body.slice(0, 6), 'Big 0:');
    // The next page goes on where this one ended: nothing is lost, nothing comes twice.
    let seen = first.messages.length;
    let cursor = first.next_cursor;
    for (let guard = 0; guard < 5 && seen < 20; guard += 1) {
      const next = await call('grok', 'read_messages', { conversation_id: lobby, after_seq: cursor });
      assert.equal(next.messages[0].sequence, cursor + 1);
      seen += next.messages.length;
      cursor = next.next_cursor;
    }
    assert.equal(seen, 20);
    // The newest messages, unasked, keep to the same bound.
    const newest = await call('codex', 'read_messages', { conversation_id: lobby });
    assert.ok(textOf(newest.messages) <= 48000 + 100, String(textOf(newest.messages)));
    assert.equal(newest.messages.at(-1).body.slice(0, 7), 'Big 19:');
  });

  it('lists the inbox newest first, within the same bound', async () => {
    for (let index = 0; index < 12; index += 1) {
      await say('claude', `For Codex ${index}: ${'i'.repeat(6000)}`, { recipient_session_ids: [ids.codex] });
    }
    const inbox = await call('codex', 'get_inbox');
    assert.equal(inbox.items[0].body.slice(0, 13), 'For Codex 11:');
    assert.ok(inbox.items.length < 12, String(inbox.items.length));
    assert.ok(textOf(inbox.items) <= 48000 + 100, String(textOf(inbox.items)));
    assert.equal(inbox.has_more, true);
  });
});
