// Test for who wrote what with which model: a message carries the model that was
// at work in its window when it was written, and the console can list everything
// one sender wrote, newest first, across conversations.
//
// Run: node --test test/mcp/history.spec.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { labelModels } from '../../src/mcp/discover.mjs';
import { recordPath, recordedModel } from '../../src/mcp/record.mjs';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-history-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;
let lobby;
let key = 0;

async function cli(client, ...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args]);
  return JSON.parse(stdout).result;
}
const call = (client, tool, args = {}) => cli(client, 'call', tool, '--json', JSON.stringify(args));
const say = (client, body, extra = {}) => call(client, 'send_message', { conversation_id: lobby, body, idempotency_key: `h${++key}`, ...extra });

/** Runs the hook as a client would: input on stdin. */
function hook(client, event, input) {
  return new Promise((done, fail) => {
    const hookArgs = instance.filter((value, index, all) => value !== '--mcp-port' && all[index - 1] !== '--mcp-port');
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', client, '--event', event, ...hookArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', fail);
    child.once('exit', (code) => done(code));
    child.stdin.end(JSON.stringify(input));
  });
}
/** Codex's bridge, started the way Codex starts it; each call names the thread it comes from. */
const open = [];
async function bridge(client, env = {}) {
  const sdk = new Client({ name: `${client}-stand-in`, version: '0.0.1' });
  await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', client, ...instance, '--no-autostart'], env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' }));
  open.push(sdk);
  return sdk;
}
const from = (thread) => ({ threadId: thread, 'x-codex-turn-metadata': { thread_id: thread, thread_source: 'user' } });
async function sayFrom(sdk, thread, body, extra = {}) {
  const response = await sdk.callTool({ name: 'send_message', arguments: { conversation_id: lobby, body, idempotency_key: `h${++key}`, ...extra }, _meta: from(thread) });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  return response.structuredContent;
}
const lobbyMessages = async () => (await service.admin('GET', `/api/v1/conversations/${lobby}/messages?after_seq=0&limit=200`)).messages;
const agentOf = async (provider) => (await service.admin('GET', '/api/v1/bootstrap')).agents.find((agent) => agent.provider === provider).agent_id;

describe('the model behind a message, and what one sender wrote', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    await cli('claude', 'call', 'get_session');
    await cli('codex', 'call', 'get_session');
    await cli('antigravity', 'call', 'get_session');
    lobby = (await service.admin('GET', '/api/v1/bootstrap')).conversations.find((conversation) => conversation.kind === 'lobby').conversation_id;
  });

  after(async () => {
    await Promise.all(open.map((sdk) => sdk.close().catch(() => undefined)));
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('says nothing about the model while nobody has told it', async () => {
    await say('claude', 'Written before any model was known.');
    const first = (await lobbyMessages()).at(-1);
    assert.equal(first.sender.model, null);
  });

  it('stamps a message with the model the sender reported when it checked in', async () => {
    // Asked, as long as nothing is known; told, afterwards.
    const asked = await call('claude', 'check_in');
    assert.equal(asked.model, null);
    assert.match(asked.model_wanted, /never guess/);
    const told = await call('claude', 'check_in', { model: 'claude-test-1' });
    assert.equal(told.model, 'claude-test-1');
    assert.equal(told.model_wanted, null);
    await say('claude', 'Written by the first model.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'claude-test-1');
    // A message keeps the model it was written with when the window moves to another one.
    await call('claude', 'check_in', { model: 'claude-test-2' });
    await say('claude', 'Written by the second model.');
    const written = (await lobbyMessages()).filter((message) => message.sender.provider === 'anthropic');
    // Known for the first time, the model is put on what the sender wrote before as well;
    // a later change leaves what is already labelled alone.
    assert.deepEqual(written.map((message) => message.sender.model), ['claude-test-1', 'claude-test-1', 'claude-test-2']);
    // A check-in that names no model leaves the known one in place.
    await call('claude', 'check_in');
    await say('claude', 'Still the second model.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'claude-test-2');
  });

  it("takes the model from a client's hook, in whichever shape the client names it", async () => {
    const codex = await bridge('codex');
    assert.equal(await hook('codex', 'prompt', { session_id: 'thread-history-1', cwd: repoRoot, model: 'gpt-test-9' }), 0);
    await sayFrom(codex, 'thread-history-1', 'Codex, as its hook named the model.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gpt-test-9');
    assert.equal(await hook('codex', 'prompt', { session_id: 'thread-history-1', cwd: repoRoot, model: { id: 'gpt-test-10', display_name: 'Test Ten' } }), 0);
    await sayFrom(codex, 'thread-history-1', 'Codex, with the model as an object.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gpt-test-10');
    // Peers see which model is at work in that window.
    const windows = (await call('claude', 'check_in')).project_sessions.find((entry) => entry.provider === 'openai').windows;
    assert.deepEqual(windows.map((entry) => entry.model), ['gpt-test-10'], JSON.stringify(windows));
  });

  it('never lends the model of one window to another window of the same application', async () => {
    const codex = open[0];
    // A second thread of the same application: nothing is known about its model yet.
    await sayFrom(codex, 'thread-history-2', 'Another thread, model unknown.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, null);
    // It says so itself when it checks in, and the first thread keeps its own.
    const checked = await codex.callTool({ name: 'check_in', arguments: { model: 'gpt-test-mini' }, _meta: from('thread-history-2') });
    assert.ok(!checked.isError, JSON.stringify(checked.structuredContent));
    await sayFrom(codex, 'thread-history-2', 'Another thread, now known.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gpt-test-mini');
    await sayFrom(codex, 'thread-history-1', 'The first thread again.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gpt-test-10');
    // Control characters and endless names do not get onto the page.
    await codex.callTool({ name: 'check_in', arguments: { model: `bad\u0007name ${'x'.repeat(90)}` }, _meta: from('thread-history-2') });
    await sayFrom(codex, 'thread-history-2', 'After an odd model name.');
    const odd = (await lobbyMessages()).at(-1).sender.model;
    assert.ok(odd !== null && odd.startsWith('badname x') && odd.length === 80, JSON.stringify(odd));
  });

  it('lists what one sender wrote, newest first, across conversations, a page at a time', async () => {
    const claude = await agentOf('anthropic');
    const codexSession = (await call('claude', 'check_in')).project_sessions.find((entry) => entry.provider === 'openai').session_id;
    await call('claude', 'direct_message', { to_session_id: codexSession, body: 'A private word.', idempotency_key: `h${++key}` });
    const all = await service.admin('GET', `/api/v1/agents/${claude}/messages`);
    assert.equal(all.total, 5);
    assert.equal(all.has_more, false);
    assert.deepEqual(all.messages.map((message) => message.body), [
      'A private word.',
      'Still the second model.',
      'Written by the second model.',
      'Written by the first model.',
      'Written before any model was known.',
    ]);
    assert.equal(all.messages[0].conversation.kind, 'direct');
    assert.equal(all.messages[1].conversation.kind, 'lobby');
    assert.equal(all.messages[1].sender.model, 'claude-test-2');
    assert.ok(all.messages.every((message) => message.sender.provider === 'anthropic'));

    const page = await service.admin('GET', `/api/v1/agents/${claude}/messages?limit=2`);
    assert.equal(page.messages.length, 2);
    assert.equal(page.has_more, true);
    const next = await service.admin('GET', `/api/v1/agents/${claude}/messages?limit=2&before=${page.next_before}`);
    assert.deepEqual(next.messages.map((message) => message.body), ['Written by the second model.', 'Written by the first model.']);

    // The operator's own words, the same way.
    await service.admin('POST', `/api/v1/conversations/${lobby}/messages`, { body: 'From the console.' });
    const console_ = await service.admin('GET', '/api/v1/agents/operator/messages');
    assert.equal(console_.total, 1);
    assert.equal(console_.messages[0].body, 'From the console.');
    assert.equal(console_.messages[0].sender.kind, 'operator');
    // Nobody: an empty list, not an error.
    assert.equal((await service.admin('GET', '/api/v1/agents/agt_nobody/messages')).total, 0);
  });

  it("reads the model from the client's own record of the conversation when the hook does not name it", async () => {
    // Claude Code names the model in every assistant entry, Codex in every turn context.
    const claudeRecord = join(base, 'claude-conv-1.jsonl');
    writeFileSync(claudeRecord, [
      { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'a text that quotes "model":"not-this-one" inside' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { model: 'claude-rec-1', role: 'assistant' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { model: '<synthetic>', role: 'assistant' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    assert.deepEqual(recordedModel(claudeRecord), { model: 'claude-rec-1' });
    const codexRecord = join(base, 'rollout-test.jsonl');
    writeFileSync(codexRecord, [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { id: 'x' } },
      { type: 'turn_context', timestamp: '2026-01-01T00:00:01.000Z', payload: { model: 'gpt-rec-1' } },
      { type: 'turn_context', timestamp: '2026-01-01T00:00:05.000Z', payload: { model: 'gpt-rec-2' } },
      { type: 'response_item', timestamp: '2026-01-01T00:00:06.000Z', payload: { type: 'message' } },
      { type: 'turn_context', timestamp: '2026-01-01T00:00:09.000Z', payload: { model: 'gpt-rec-2' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    // The model changed within the record: the present one counts from its first entry.
    assert.deepEqual(recordedModel(codexRecord), { model: 'gpt-rec-2', since: '2026-01-01T00:00:05.000Z' });
    const emptyRecord = join(base, 'empty-record.jsonl');
    writeFileSync(emptyRecord, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    assert.deepEqual(recordedModel(emptyRecord), {});
    assert.deepEqual(recordedModel(join(base, 'no-such-record.jsonl')), {});
    // A long last turn: the model is named further back than a hook reads, and the
    // gateway, which may read on, still finds it, with lines that span the pieces it reads in.
    const longRecord = join(base, 'rollout-long.jsonl');
    const filler = JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:07.000Z', payload: { text: 'x'.repeat(900_000) } });
    writeFileSync(longRecord, [
      JSON.stringify({ type: 'turn_context', timestamp: '2026-01-01T00:00:01.000Z', payload: { model: 'gpt-far-0' } }),
      JSON.stringify({ type: 'turn_context', timestamp: '2026-01-01T00:00:05.000Z', payload: { model: 'gpt-far-1' } }),
      ...Array.from({ length: 6 }, () => filler),
    ].join('\n') + '\n');
    assert.deepEqual(recordedModel(longRecord), {});
    assert.deepEqual(recordedModel(longRecord, { maxBytes: 64 * 1024 * 1024 }), { model: 'gpt-far-1', since: '2026-01-01T00:00:05.000Z' });
    assert.deepEqual(recordedModel(undefined), {});

    // A Claude conversation that has been open for a while: its hooks name no model.
    const claude = await bridge('claude', { ACM_CLIENT_SESSION: 'claude-conv-1' });
    const send = async (sdk, body) => {
      const response = await sdk.callTool({ name: 'send_message', arguments: { conversation_id: lobby, body, idempotency_key: `h${++key}` } });
      assert.ok(!response.isError, JSON.stringify(response.structuredContent));
    };
    await send(claude, 'Before anything was known about this conversation.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, null);
    assert.equal(await hook('claude', 'prompt', { session_id: 'claude-conv-1', cwd: repoRoot, transcript_path: claudeRecord }), 0);
    await send(claude, 'After the hook read the record.');
    const written = (await lobbyMessages()).slice(-2);
    // Known for the first time: what the conversation wrote before gets it too.
    assert.deepEqual(written.map((message) => message.sender.model), ['claude-rec-1', 'claude-rec-1']);
    // Other conversations of the same application are left as they were.
    const untouched = (await lobbyMessages()).find((message) => message.body === 'Still the second model.');
    assert.equal(untouched.sender.model, 'claude-test-2');
  });

  it('does not reach back past the point where the client saw the model change', async () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    const record = join(base, 'claude-conv-2.jsonl');
    writeFileSync(record, [
      { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { model: 'claude-old' } },
      { type: 'assistant', timestamp: later, message: { model: 'claude-new' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const claude = await bridge('claude', { ACM_CLIENT_SESSION: 'claude-conv-2' });
    const send = async (body) => {
      const response = await claude.callTool({ name: 'send_message', arguments: { conversation_id: lobby, body, idempotency_key: `h${++key}` } });
      assert.ok(!response.isError, JSON.stringify(response.structuredContent));
    };
    await send('Written while the other model was at work.');
    assert.equal(await hook('claude', 'prompt', { session_id: 'claude-conv-2', cwd: repoRoot, transcript_path: record }), 0);
    await send('Written by the new model.');
    assert.deepEqual((await lobbyMessages()).slice(-2).map((message) => message.sender.model), [null, 'claude-new']);
    // A later change of model does not rewrite what is already labelled.
    writeFileSync(record, JSON.stringify({ type: 'assistant', timestamp: later, message: { model: 'claude-newer' } }) + '\n');
    assert.equal(await hook('claude', 'prompt', { session_id: 'claude-conv-2', cwd: repoRoot, transcript_path: record }), 0);
    await send('Written by the newest model.');
    assert.deepEqual((await lobbyMessages()).slice(-3).map((message) => message.sender.model), [null, 'claude-new', 'claude-newer']);
  });

  it('labels a message that no window is known for by the windows at work, when they agree', async () => {
    // Antigravity names the conversation in its hooks only: its tool calls come without one.
    assert.equal(await hook('antigravity', 'prompt', { conversationId: 'agy-conv-1', workspacePaths: [repoRoot], model: 'gemini-test-1' }), 0);
    await say('antigravity', 'One conversation at work.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gemini-test-1');
    assert.equal(await hook('antigravity', 'prompt', { conversationId: 'agy-conv-2', workspacePaths: [repoRoot], model: 'gemini-test-1' }), 0);
    await say('antigravity', 'Two at work, on the same model.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, 'gemini-test-1');
    // Two models at work: which one wrote this cannot be told, so nothing is claimed.
    assert.equal(await hook('antigravity', 'prompt', { conversationId: 'agy-conv-3', workspacePaths: [repoRoot], model: 'gemini-test-2' }), 0);
    await say('antigravity', 'Two models at work.');
    assert.equal((await lobbyMessages()).at(-1).sender.model, null);
    // Asked, the model says which one it is; that stands where the windows do not agree,
    // and does not reach back over what several conversations wrote.
    const asked = await call('antigravity', 'check_in');
    assert.match(asked.model_wanted, /never guess/);
    await call('antigravity', 'check_in', { model: 'gemini-said-so' });
    await say('antigravity', 'After saying so itself.');
    assert.deepEqual((await lobbyMessages()).slice(-2).map((message) => message.sender.model), [null, 'gemini-said-so']);
  });

  it('gives a conversation that has ended the model its record names', async () => {
    // A Codex thread and a Claude conversation that wrote something and will never run a hook again.
    const codex = open[0];
    const thread = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
    await sayFrom(codex, thread, 'An old thread, first message.');
    await sayFrom(codex, thread, 'An old thread, second message.');
    const claude = await bridge('claude', { ACM_CLIENT_SESSION: 'claude-old-1' });
    const response = await claude.callTool({ name: 'send_message', arguments: { conversation_id: lobby, body: 'An old Claude conversation.', idempotency_key: `h${++key}` } });
    assert.ok(!response.isError, JSON.stringify(response.structuredContent));
    assert.deepEqual((await lobbyMessages()).slice(-3).map((message) => message.sender.model), [null, null, null]);

    // What the clients keep on disk, in a home of their own for this test.
    const home = join(base, 'home');
    const day = join(home, '.codex', 'sessions', '2026', '01', '02');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-01-02T03-04-05-${thread}.jsonl`), [
      { type: 'session_meta', timestamp: '2026-01-02T03:04:05.000Z', payload: { id: thread } },
      { type: 'turn_context', timestamp: '2026-01-02T03:04:06.000Z', payload: { model: 'gpt-old-thread' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const project = join(home, '.claude', 'projects', 'C--some-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'claude-old-1.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T03:04:06.000Z', message: { model: 'claude-old-conv' } }) + '\n');
    const env = { USERPROFILE: home, HOME: home };
    assert.equal(recordPath('codex', thread, { env }), join(day, `rollout-2026-01-02T03-04-05-${thread}.jsonl`));
    assert.equal(recordPath('claude', 'claude-old-1', { env }), join(project, 'claude-old-1.jsonl'));
    assert.equal(recordPath('claude', '..\\..\\elsewhere', { env }), undefined);
    assert.equal(recordPath('antigravity', 'anything', { env }), undefined);

    const state = { index: new Map(), tried: new Map() };
    const labelled = await labelModels({ coreUrl: service.coreUrl, adminToken: () => service.adminToken, env, state });
    assert.equal(labelled, 2);
    assert.deepEqual((await lobbyMessages()).slice(-3).map((message) => message.sender.model), ['gpt-old-thread', 'gpt-old-thread', 'claude-old-conv']);
    // Nothing is left to ask for, and a window without a record is not looked at every time.
    await sayFrom(codex, '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002', 'A thread without a record.');
    assert.equal(await labelModels({ coreUrl: service.coreUrl, adminToken: () => service.adminToken, env, state }), 0);
    assert.equal(state.tried.size, 1);
    assert.equal((await lobbyMessages()).at(-1).sender.model, null);
    // Only the console's own credential may report models.
    const refused = await fetch(`${service.coreUrl}/api/v1/windows/models`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acm-admin-token': 'acmadmin_wrong' }, body: '{"models":[]}' });
    assert.equal(refused.status, 401);
  });

  it('is for the console only', async () => {
    const claude = await agentOf('anthropic');
    const refused = await fetch(`${service.coreUrl}/api/v1/agents/${claude}/messages`, { headers: { 'x-acm-admin-token': 'acmadmin_wrong' } });
    assert.equal(refused.status, 401);
    const tools = (await cli('claude', 'tools')).map((tool) => tool.name);
    assert.ok(!tools.some((name) => /sender_messages|history/.test(name)));
  });
});
