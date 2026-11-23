// Test for direct messages that wait for an answer: check_in puts what is said to
// a session alone before the lobby, and lists a direct message again with every
// check-in until the session replies or acknowledges it. Reading it once does
// not settle it.
//
// Run: node --test test/mcp/waiting.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-waiting-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;
let lobby;
const ids = {};
let key = 0;
const open = [];

async function cli(client, ...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args]);
  return JSON.parse(stdout).result;
}
const call = (client, tool, args = {}) => cli(client, 'call', tool, '--json', JSON.stringify(args));
const direct = (from, to, body, extra = {}) => call(from, 'direct_message', { to_session_id: ids[to], body, idempotency_key: `w${++key}`, ...extra });
const waitingOf = async (client) => (await call(client, 'check_in')).awaiting_your_reply;

/** Codex's bridge, started the way Codex starts it; each call names the thread it comes from. */
async function bridge(client) {
  const sdk = new Client({ name: `${client}-stand-in`, version: '0.0.1' });
  await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', client, ...instance, '--no-autostart'], env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' }, stderr: 'pipe' }));
  open.push(sdk);
  return sdk;
}
const from = (thread) => ({ threadId: thread, 'x-codex-turn-metadata': { thread_id: thread, thread_source: 'user' } });
async function tool(sdk, thread, name, args = {}) {
  const response = await sdk.callTool({ name, arguments: args, _meta: from(thread) });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  return response.structuredContent;
}

describe('messages that wait for an answer', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    for (const client of ['claude', 'codex', 'grok']) {
      ids[client] = (await cli(client, 'call', 'get_session')).session_id;
    }
    // What a new installation allows: room for an application with several conversations at work.
    const settings = (await service.admin('GET', '/api/v1/bootstrap')).settings;
    assert.deepEqual([settings.message_rate_per_minute, settings.message_rate_per_hour, settings.duplicate_window_seconds, settings.urgent_per_hour], [60, 600, 120, 30]);
    // This test sends many messages in a row; the flood limits have their own test.
    await service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: 0, message_rate_per_hour: 0 });
    lobby = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((conversation) => conversation.kind === 'lobby').conversation_id;
  });

  after(async () => {
    await Promise.all(open.map((sdk) => sdk.close().catch(() => undefined)));
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('has nothing to say while nobody wrote to the session directly', async () => {
    await call('claude', 'send_message', { conversation_id: lobby, body: 'Something for everybody.', idempotency_key: `w${++key}` });
    const checked = await call('grok', 'check_in');
    assert.equal(checked.awaiting_your_reply, null);
  });

  it('puts a direct conversation before the lobby, and names what waits before anything else', async () => {
    for (let index = 0; index < 4; index += 1) {
      await call('claude', 'send_message', { conversation_id: lobby, body: `Lobby traffic ${index}.`, idempotency_key: `w${++key}` });
    }
    const sent = await direct('claude', 'grok', 'Please pass the snow depth request on.');
    await call('claude', 'send_message', { conversation_id: lobby, body: 'More lobby traffic.', idempotency_key: `w${++key}` });
    const checked = await call('grok', 'check_in');
    // The answer begins with it, and the direct conversation comes before the lobby.
    assert.equal(Object.keys(checked)[0], 'awaiting_your_reply');
    assert.deepEqual(checked.conversations.map((conversation) => conversation.kind), ['direct', 'lobby']);
    assert.match(checked.awaiting_your_reply.note, /every check_in until you reply/);
    assert.equal(checked.awaiting_your_reply.messages.length, 1);
    const waiting = checked.awaiting_your_reply.messages[0];
    assert.equal(waiting.message_id, sent.message_id);
    assert.equal(waiting.from.session_id, ids.claude);
    // New in this very check-in: its text is with the new messages, not twice in the answer.
    assert.equal(waiting.in_new_messages, true);
    assert.equal(waiting.body, null);
    assert.equal(checked.conversations[0].new_messages[0].body, 'Please pass the snow depth request on.');
  });

  it('lists it again, in full, with every check-in after it was read', async () => {
    for (let round = 0; round < 3; round += 1) {
      const checked = await call('grok', 'check_in');
      // Read already: it is not new any more ...
      assert.deepEqual(checked.conversations[0].new_messages, []);
      // ... and still there, with its text.
      assert.equal(checked.awaiting_your_reply.messages.length, 1);
      assert.equal(checked.awaiting_your_reply.messages[0].body, 'Please pass the snow depth request on.');
      assert.equal(checked.awaiting_your_reply.messages[0].in_new_messages, undefined);
    }
    // The sender is not asked to answer itself.
    assert.equal(await waitingOf('claude'), null);
    // A check-in that is limited to one conversation is not the place for it.
    assert.equal((await call('grok', 'check_in', { conversation_id: lobby })).awaiting_your_reply, null);
  });

  it('settles it with a reply, and then the other side is the one that is asked', async () => {
    await direct('grok', 'claude', 'Passed on. Anything else?');
    assert.equal(await waitingOf('grok'), null);
    const asked = await waitingOf('claude');
    assert.deepEqual(asked.messages.map((message) => message.in_new_messages), [true]);
    assert.equal((await waitingOf('claude')).messages[0].body, 'Passed on. Anything else?');
  });

  it('settles it with an acknowledgement when no reply is needed', async () => {
    const waiting = (await waitingOf('claude')).messages[0];
    await call('claude', 'acknowledge_message', { message_id: waiting.message_id });
    assert.equal(await waitingOf('claude'), null);
    // Several in a row: each waits on its own, oldest first, and one reply answers them all.
    await direct('claude', 'grok', 'First of three.');
    await direct('claude', 'grok', 'Second of three.', { urgent: true });
    const third = await direct('claude', 'grok', 'Third of three.');
    await call('grok', 'check_in');
    const listed = (await waitingOf('grok')).messages;
    assert.deepEqual(listed.map((message) => message.body), ['First of three.', 'Second of three.', 'Third of three.']);
    assert.deepEqual(listed.map((message) => message.urgent), [false, true, false]);
    await call('grok', 'acknowledge_message', { message_id: third.message_id });
    assert.deepEqual((await waitingOf('grok')).messages.map((message) => message.body), ['First of three.', 'Second of three.']);
    await direct('grok', 'claude', 'Got all three.');
    assert.equal(await waitingOf('grok'), null);
  });

  it('cuts a very long one, and says so', async () => {
    await direct('claude', 'grok', `Long: ${'x'.repeat(6000)}`);
    await call('grok', 'check_in');
    const waiting = (await waitingOf('grok')).messages[0];
    assert.equal(waiting.cut, true);
    assert.ok(waiting.body.length < 4200 && waiting.body.endsWith('read_messages has the rest]'));
    await call('grok', 'acknowledge_message', { message_id: waiting.message_id });
    // Several long ones: the list comes with every check-in, so it keeps to a size. The
    // newest are in full, an older one is a reminder that says where the rest is.
    for (const name of ['oldest', 'middle', 'newest']) {
      await direct('claude', 'grok', `${name}: ${'y'.repeat(3500)}`);
    }
    await call('grok', 'check_in');
    const listed = (await waitingOf('grok')).messages;
    assert.deepEqual(listed.map((message) => message.body.slice(0, 6)), ['oldest', 'middle', 'newest']);
    assert.deepEqual(listed.map((message) => message.cut === true), [true, false, false]);
    assert.ok(listed[0].body.length < 1200, String(listed[0].body.length));
    assert.ok(listed.reduce((sum, message) => sum + message.body.length, 0) < 8200);
    await direct('grok', 'claude', 'Read all three.');
    await call('claude', 'acknowledge_message', { message_id: (await waitingOf('claude')).messages[0].message_id });
  });

  it('asks only the window that takes part in the direct conversation', async () => {
    const codex = await bridge('codex');
    // Thread A writes to Claude; Claude answers the session. Thread B has nothing to do with it.
    await tool(codex, 'thread-a', 'direct_message', { to_session_id: ids.claude, body: 'Thread A asks.', idempotency_key: `w${++key}` });
    await tool(codex, 'thread-b', 'check_in');
    await call('claude', 'acknowledge_message', { message_id: (await waitingOf('claude')).messages[0].message_id });
    await direct('claude', 'codex', 'An answer for thread A.');
    assert.equal((await tool(codex, 'thread-b', 'check_in')).awaiting_your_reply, null);
    assert.equal((await tool(codex, 'thread-b', 'check_in')).awaiting_your_reply, null);
    const first = await tool(codex, 'thread-a', 'check_in');
    assert.equal(first.awaiting_your_reply.messages.length, 1);
    const again = await tool(codex, 'thread-a', 'check_in');
    assert.equal(again.awaiting_your_reply.messages[0].body, 'An answer for thread A.');
    // A call that names no thread may be any of them: it is told.
    assert.equal((await waitingOf('codex')).messages.length, 1);
    await tool(codex, 'thread-a', 'direct_message', { to_session_id: ids.claude, body: 'Thanks.', idempotency_key: `w${++key}` });
    assert.equal((await tool(codex, 'thread-a', 'check_in')).awaiting_your_reply, null);
    await call('claude', 'acknowledge_message', { message_id: (await waitingOf('claude')).messages[0].message_id });
  });

  it('asks the same for a lobby message that is for one session alone', async () => {
    const sent = await call('claude', 'send_message', { conversation_id: lobby, body: 'Grok: is the registry in place?', recipient_session_ids: [ids.grok], idempotency_key: `w${++key}` });
    await call('grok', 'check_in');
    const waiting = (await waitingOf('grok')).messages;
    assert.deepEqual(waiting.map((message) => [message.message_id, message.in, message.why]), [[sent.message_id, 'the lobby', 'it was sent to your session alone']]);
    assert.equal(waiting[0].body, 'Grok: is the registry in place?');
    // Nobody else is asked, and writing in the lobby afterwards is the answer.
    assert.equal(await waitingOf('codex'), null);
    await call('grok', 'send_message', { conversation_id: lobby, body: 'In place.', idempotency_key: `w${++key}` });
    assert.equal(await waitingOf('grok'), null);
  });

  it('asks the window a message names, and only that one', async () => {
    const codex = open[0];
    const windows = (await tool(codex, 'thread-a', 'check_in')).project_sessions;
    const own = (await tool(codex, 'thread-a', 'check_in')).window.name;
    assert.ok(typeof own === 'string' && own !== '', JSON.stringify(windows).slice(0, 200));
    const sent = await call('claude', 'send_message', { conversation_id: lobby, body: 'Thread A: rerun the audit.', to_windows: [own], idempotency_key: `w${++key}` });
    assert.equal((await tool(codex, 'thread-b', 'check_in')).awaiting_your_reply, null);
    await tool(codex, 'thread-a', 'check_in');
    const waiting = (await tool(codex, 'thread-a', 'check_in')).awaiting_your_reply.messages;
    assert.deepEqual(waiting.map((message) => [message.message_id, message.why]), [[sent.message_id, 'it names your window']]);
    // A call that names no thread cannot be told from the other windows: it is left to the hooks of the one named.
    assert.equal(await waitingOf('codex'), null);
    // What the other thread writes is no answer; what the named one writes is.
    await tool(codex, 'thread-b', 'send_message', { conversation_id: lobby, body: 'Thread B about something else.', idempotency_key: `w${++key}` });
    assert.equal((await tool(codex, 'thread-a', 'check_in')).awaiting_your_reply.messages.length, 1);
    await tool(codex, 'thread-a', 'send_message', { conversation_id: lobby, body: 'Audit rerun.', idempotency_key: `w${++key}` });
    assert.equal((await tool(codex, 'thread-a', 'check_in')).awaiting_your_reply, null);
  });

  it('never lets a busy lobby hide a message that is for the reader', async () => {
    await call('grok', 'check_in');
    await call('claude', 'send_message', { conversation_id: lobby, body: 'Grok: one more thing, early in a long stretch.', recipient_session_ids: [ids.grok], idempotency_key: `w${++key}` });
    for (let index = 0; index < 25; index += 1) {
      await call('claude', 'send_message', { conversation_id: lobby, body: `Later lobby traffic ${index}.`, idempotency_key: `w${++key}` });
    }
    const checked = await call('grok', 'check_in');
    const place = checked.conversations.find((conversation) => conversation.kind === 'lobby');
    // The page holds the newest fifteen; the one for this reader comes along all the same ...
    assert.equal(place.new_messages.length, 15);
    assert.ok(place.skipped_earlier > 0);
    assert.ok(!place.new_messages.some((message) => message.body.startsWith('Grok: one more thing')));
    assert.deepEqual(place.kept_messages.map((message) => message.body), ['Grok: one more thing, early in a long stretch.']);
    // ... and it is named first, with its text, as waiting.
    assert.equal(checked.awaiting_your_reply.messages.at(-1).body, 'Grok: one more thing, early in a long stretch.');
    await call('grok', 'send_message', { conversation_id: lobby, body: 'Seen.', idempotency_key: `w${++key}` });
  });

  it('gives a kept message that names other windows in full to those windows only', async () => {
    const codex = open[0];
    const own = (await tool(codex, 'thread-a', 'check_in')).window.name;
    await call('grok', 'check_in');
    const long = `Thread A, the full specification: ${'z'.repeat(2500)}`;
    const sent = await call('claude', 'send_message', { conversation_id: lobby, body: long, to_windows: [own], idempotency_key: `w${++key}` });
    // The operator keeps it in front of readers; then a long stretch of other traffic.
    await service.admin('POST', `/api/v1/conversations/${lobby}/compact`, { keep: [sent.sequence] });
    for (let index = 0; index < 20; index += 1) {
      await call('claude', 'send_message', { conversation_id: lobby, body: `Traffic after the specification ${index}.`, idempotency_key: `w${++key}` });
    }
    // A reader it does not name gets to know that it is there, not its whole text.
    const other = (await call('grok', 'check_in')).conversations.find((conversation) => conversation.kind === 'lobby');
    const overview = other.kept_messages.find((message) => message.message_id === sent.message_id);
    assert.equal(overview.cut, true);
    assert.ok(overview.body.length < 700, String(overview.body.length));
    // The window it names gets it whole.
    const named = (await tool(codex, 'thread-a', 'check_in')).conversations.find((conversation) => conversation.kind === 'lobby');
    assert.equal(named.kept_messages.find((message) => message.message_id === sent.message_id).body, long);
  });
});
