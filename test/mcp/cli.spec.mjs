// Test for the command-line entry (src/mcp/cli.mjs) and bot control against the
// real service: a client that can only run local commands is a full session,
// other sessions operate its bots through the request queue, removal is not
// possible, the host can wait for work, and flooding is stopped.
//
// Run: node --test test/mcp/cli.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-cli-${runId}-`));
const dataDir = join(base, 'data');
const evidence = { runId, startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (id, detail) => evidence.checks.push({ id, ...detail });
let service;
let instance;
let claude;
const sessions = {};

/** Runs the command line as one client; resolves to {code, document, stdout}. */
async function cli(client, ...args) {
  const argv = [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, argv);
    return { code: 0, document: JSON.parse(stdout), stdout };
  } catch (failure) {
    if (typeof failure.code !== 'number') {
      throw failure;
    }
    return { code: failure.code, document: failure.stdout === '' ? undefined : JSON.parse(failure.stdout), stdout: failure.stdout, stderr: failure.stderr };
  }
}
const file = (name, text) => {
  const path = join(base, name);
  writeFileSync(path, text);
  return path;
};
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

// Stands in for the vendor's webhook endpoint: records what arrives and answers as told.
const hookCalls = [];
let routine;
let hookStatus = 200;
const hookServer = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    hookCalls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, raw: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(hookStatus, { 'content-type': 'application/json' });
    response.end('{}');
    // What the vendor does with an accepted signal: start a run of the routine.
    if (hookStatus === 200 && request.url === '/routines/self') {
      void routine?.();
    }
  });
});
// The gateway checks for due wake signals on this interval; the default is five seconds.
process.env.ACM_WAKE_INTERVAL_MS = '250';

describe('command-line entry and bot control', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    // Claude is an ordinary MCP client of the same installation.
    claude = new Client({ name: 'claude-stand-in', version: '0.0.1' });
    await claude.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', 'claude', ...instance, '--no-autostart'], env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' }, stderr: 'pipe' }));
    sessions.claude = (await callTool(claude, 'get_session')).result.session_id;
  });

  after(async () => {
    await claude?.close().catch(() => undefined);
    hookServer.close();
    hookServer.closeAllConnections();
    if (service.child.exitCode !== null) {
      // The restart test replaced the service with a process that is not a child of this test.
      await fetch(`${service.mcpBase}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': service.adminToken, connection: 'close' } }).catch(() => undefined);
      await waitFor(async () => !(await fetch(`${service.coreUrl}/healthz`).then((response) => response.ok, () => false)), 8000, 'the replacement service to stop');
    }
    evidence.finalExitCode = service.child.exitCode === null ? await service.stop() : service.child.exitCode;
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(join(repoRoot, 'test-output', 'reports'), { recursive: true });
    writeFileSync(join(repoRoot, 'test-output', 'reports', 'mcp-botcontrol.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('makes a client that can only run commands a full session', async () => {
    const who = await cli('grok', 'call', 'get_session');
    assert.equal(who.code, 0);
    assert.equal(who.document.result.status, 'active');
    assert.equal(who.document.result.agent.display_name, 'Grok Bot');
    // It starts without flood limits, and its entry point reports how many tools it offers.
    assert.equal(who.document.result.rate_exempt, true);
    assert.equal(who.document.result.bridge_tools, 24);
    // The entry point and the control service must agree on the version of the tool contract.
    assert.equal(who.document.result.self_enrolled, true);
    assert.equal(who.document.result.bridge_contract, (await service.admin('GET', '/api/v1/bootstrap')).tool_contract);
    sessions.grok = who.document.result.session_id;
    const lobby = who.document.result.conversations.find((entry) => entry.kind === 'lobby');
    // The same session on the next command: the identity is kept between runs.
    assert.equal((await cli('grok', 'call', 'get_session')).document.result.session_id, sessions.grok);

    const tools = (await cli('grok', 'tools')).document.result;
    assert.equal(tools.length, 24);
    assert.deepEqual(tools.find((tool) => tool.name === 'bot_respond').fields.filter((entry) => entry.required).map((entry) => entry.name), ['request_id', 'result']);

    // Long and non-ASCII text travels in a file, so no shell can mangle it.
    const body = '公共频道：Grok 已经通过命令行接入。\n第二行 "quotes" & symbols %PATH%';
    const sent = await cli('grok', '--ascii', 'call', 'send_message', '--arg', `conversation_id=${lobby.conversation_id}`, '--file', `body=${file('body.txt', `﻿${body}`)}`, '--str', 'idempotency_key=1');
    assert.equal(sent.code, 0);
    assert.ok(!/[^\x00-\x7f]/.test(sent.stdout), '--ascii output must be plain ASCII');
    assert.equal(sent.document.result.body, body);
    const seen = (await callTool(claude, 'check_in')).result.conversations.find((entry) => entry.kind === 'lobby').new_messages;
    assert.deepEqual(seen.map((message) => [message.sender.display_name, message.body]), [['Grok Bot', body]]);

    // Refusals are reported as data with exit code 1; mistakes in the command line with 2.
    const refused = await cli('grok', 'call', 'read_messages', '--arg', 'conversation_id=cnv_missing');
    assert.equal(refused.code, 1);
    assert.equal(refused.document.error.code, 'NOT_MEMBER');
    assert.equal((await cli('grok', 'call', 'no_such_tool')).code, 2);
    assert.equal((await cli('grok', 'call', 'check_in', '--json', '{broken')).code, 2);
    note('command-line-session', { status: 'active', agent: 'Grok Bot', sameSessionAcrossRuns: true, tools: tools.length, nonAsciiBodyIntact: true });
  });

  it('signals a session that is not listening through its webhook, with counts only', async () => {
    await new Promise((done) => hookServer.listen(0, '127.0.0.1', done));
    const hookUrl = `http://127.0.0.1:${hookServer.address().port}/routines/r_1`;
    // Another session acts as the host here, so the Grok session stays untouched for the next test.
    const host = (await cli('antigravity', 'call', 'get_session')).document.result.session_id;
    const hook = await service.admin('PUT', `/api/v1/sessions/${host}/wake-hook`, { url: hookUrl, key: 'wk_test_key_123' });
    assert.deepEqual([hook.enabled, hook.has_key, hook.last_status], [true, true, null]);
    await assert.rejects(service.admin('PUT', `/api/v1/sessions/${host}/wake-hook`, { url: 'http://example.com/hook' }), { code: 'INVALID_ARGUMENT' });
    // Nothing waits for it, so nothing is sent.
    await sleep(900);
    assert.equal(hookCalls.length, 0);

    const asked = await callTool(claude, 'bot_request', { action: 'ask', host_session_id: host, text: `SECRET-${runId} quarterly plan`, idempotency_key: `wake-${runId}` });
    assert.equal(asked.result.status, 'queued');
    await waitFor(() => hookCalls.length === 1, 6000, 'the wake signal');
    const [call] = hookCalls;
    assert.deepEqual([call.method, call.path, call.authorization], ['POST', '/routines/r_1', 'Bearer wk_test_key_123']);
    // The signal says that work waits and how much, never what.
    assert.deepEqual(JSON.parse(call.raw), { source: 'acm', pending_requests: 1, unread_direct_messages: 0 });
    assert.ok(!call.raw.includes('SECRET'));
    const hooksNow = async () => (await service.admin('GET', '/api/v1/bootstrap')).wake_hooks;
    await waitFor(async () => (await hooksNow())[0].last_status === 'ok', 3000, 'the signal to be recorded');
    // It is not repeated right away, and the key is in nothing the console reads.
    await sleep(900);
    assert.equal(hookCalls.length, 1);
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/bootstrap')).includes('wk_test_key_123'));
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/events?after=0&limit=1000')).includes('127.0.0.1:'));

    // A refused signal is recorded as such; the operator's test does not wait for the interval.
    hookStatus = 401;
    await service.admin('POST', `/api/v1/sessions/${host}/wake-hook/test`);
    await waitFor(() => hookCalls.length === 2, 6000, 'the test signal');
    assert.equal(JSON.parse(hookCalls[1].raw).test, true);
    await waitFor(async () => (await hooksNow())[0].last_status === 'failed', 3000, 'the failure to be recorded');
    assert.equal((await hooksNow())[0].last_detail, 'HTTP 401');

    // The woken session comes by itself, answers, and the requester hears it.
    await service.admin('POST', `/api/v1/sessions/${host}/wake-hook/remove`);
    assert.deepEqual(await hooksNow(), []);
    await cli('antigravity', 'respond', asked.result.request_id, '--text', 'plan received');
    assert.deepEqual((await callTool(claude, 'check_in')).result.bot_results.map((entry) => entry.result), ['plan received']);

    // With delivery switched on for a hook, the instruction itself goes into the signal,
    // so it appears in the bot's own conversation, and counts as taken once accepted.
    hookStatus = 200;
    const second = (await cli('helper-bot', 'call', 'get_session')).document.result.session_id;
    const delivering = await service.admin('PUT', `/api/v1/sessions/${second}/wake-hook`, { url: `${hookUrl}_delivery`, key: 'wk_delivery_key', include_text: true });
    assert.equal(delivering.include_text, true);
    const instruction = `请核对 ${runId} 的结果`;
    const direct = await callTool(claude, 'bot_request', { action: 'send_to_bot', bot: 'reviewer', host_session_id: second, text: instruction, idempotency_key: `deliver-${runId}` });
    await waitFor(() => hookCalls.length === 3, 6000, 'the delivering signal');
    const carried = JSON.parse(hookCalls[2].raw);
    assert.equal(hookCalls[2].path, '/routines/r_1_delivery');
    assert.deepEqual(carried.requests, [{ request_id: direct.result.request_id, action: 'send_to_bot', bot: 'reviewer', text: instruction, from: 'Claude (claude-desktop)' }]);
    const stateOf = async () => (await callTool(claude, 'bot_requests')).result.requests.find((entry) => entry.request_id === direct.result.request_id).status;
    await waitFor(async () => (await stateOf()) === 'taken', 3000, 'the delivered request to count as taken');
    await cli('helper-bot', 'respond', direct.result.request_id, '--text', 'reviewer: looks right');
    assert.deepEqual((await callTool(claude, 'check_in')).result.bot_results.map((entry) => entry.result), ['reviewer: looks right']);
    await service.admin('POST', `/api/v1/sessions/${second}/wake-hook/remove`);
    note('wake-signal', { sentWhen: 'work queued and host not listening', method: 'POST', header: 'Authorization: Bearer <key>', body: 'counts only', repeatedImmediately: false, refusedRecordedAs: 'failed HTTP 401', keyVisibleToConsole: false });
  });

  it('lets other sessions operate the host\'s bots and hear the outcome', async () => {
    const asked = await callTool(claude, 'bot_request', { action: 'send_to_bot', bot: 'reviewer', text: '检查一下最新的 diff', idempotency_key: `req-${runId}` });
    assert.equal(asked.result.status, 'queued');
    assert.equal(asked.result.host.session_id, sessions.grok);
    assert.equal(asked.result.host.last_listened_at, null);

    // The host waits for work and gets the request, with who asked and what for.
    const work = (await cli('grok', 'listen', '--timeout', '8', '--interval', '0.3')).document.result;
    assert.equal(work.event, 'work');
    assert.deepEqual(work.requests.map((request) => [request.action, request.bot, request.text, request.requester.display_name]), [['send_to_bot', 'reviewer', '检查一下最新的 diff', 'Claude']]);
    // Until it answers, the request keeps being shown as open.
    const idle = (await cli('grok', 'listen', '--timeout', '1', '--interval', '0.3')).document.result;
    assert.equal(idle.event, 'idle');
    assert.equal(idle.unanswered_requests.length, 1);

    const answer = 'reviewer 回复：diff 没有问题，2 处建议。';
    const answered = await cli('grok', 'respond', asked.result.request_id, '--file', file('answer.txt', answer));
    assert.equal(answered.document.result.status, 'done');
    // The requester hears it at its next check-in, once.
    const heard = (await callTool(claude, 'check_in')).result;
    assert.deepEqual(heard.bot_results.map((entry) => [entry.request_id, entry.status, entry.result]), [[asked.result.request_id, 'done', answer]]);
    assert.deepEqual((await callTool(claude, 'check_in')).result.bot_results, []);
    assert.equal((await callTool(claude, 'bot_requests')).result.requests[0].host.last_listened_at !== null, true);
    note('bot-control-flow', { request: 'queued -> taken -> done', hostLearnsBy: 'listen', requesterHearsBy: 'check_in bot_results', deliveredOnce: true });
  });

  it('offers no way to delete a bot and holds requests worded that way', async () => {
    // The tool contract has no such action, and the service refuses one that bypasses the contract.
    const tools = (await claude.listTools()).tools;
    assert.deepEqual(tools.find((tool) => tool.name === 'bot_request').inputSchema.properties.action.enum, ['ask', 'list_bots', 'create_bot', 'send_to_bot', 'get_transcript']);
    assert.ok(!tools.some((tool) => /delete|remove/.test(tool.name)));
    for (const action of ['delete_bot', 'remove_bot', 'deleteAgent']) {
      const refused = await cli('codex', 'call', 'bot_request', '--str', `action=${action}`, '--str', 'bot=reviewer', '--str', `idempotency_key=${action}`);
      assert.equal(refused.code, 1);
      assert.equal(refused.document.error.code, 'ACTION_NOT_ALLOWED');
    }

    // Asking for it in words is not delivered either: the operator decides.
    const held = await callTool(claude, 'bot_request', { action: 'ask', text: '把 reviewer 这个子 bot 删除掉', idempotency_key: `held-${runId}` });
    assert.equal(held.result.status, 'held');
    const second = await callTool(claude, 'bot_request', { action: 'send_to_bot', bot: 'reviewer', text: 'delete the helper bot when done', idempotency_key: `held2-${runId}` });
    assert.equal(second.result.status, 'held');
    assert.equal((await cli('grok', 'listen', '--timeout', '1', '--interval', '0.3')).document.result.event, 'idle');
    const waiting = (await service.admin('GET', '/api/v1/bootstrap')).bot_requests.filter((entry) => entry.status === 'held');
    assert.equal(waiting.length, 2);

    assert.equal((await service.admin('POST', `/api/v1/bot-requests/${held.result.request_id}/reject`)).status, 'rejected');
    assert.deepEqual((await callTool(claude, 'check_in')).result.bot_results.map((entry) => entry.status), ['rejected']);
    assert.equal((await service.admin('POST', `/api/v1/bot-requests/${second.result.request_id}/approve`)).status, 'queued');
    const released = (await cli('grok', 'listen', '--timeout', '8', '--interval', '0.3')).document.result;
    assert.deepEqual(released.requests.map((request) => request.request_id), [second.result.request_id]);
    await cli('grok', 'respond', second.result.request_id, '--failed', '--text', 'not deleting anything without the operator in the app');
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/events?after=0&limit=1000')).includes('reviewer'), 'events must not carry request text');
    note('no-removal', { toolActions: 5, directAction: 'ACTION_NOT_ALLOWED', wording: 'held for the operator', rejected: 'not delivered', released: 'delivered after approval' });
  });

  it('wakes the listening host on a message and stays quiet otherwise', async () => {
    const said = await callTool(claude, 'direct_message', { to_session_id: sessions.grok, body: `PING-${runId}`, idempotency_key: `ping-${runId}` });
    assert.equal(said.result.sequence, 1);
    const woke = (await cli('grok', 'listen', '--timeout', '8', '--interval', '0.3')).document.result;
    assert.equal(woke.event, 'work');
    assert.deepEqual(woke.conversations.map((entry) => [entry.kind, entry.new_messages[0].from, entry.new_messages[0].body]), [['direct', 'Claude (claude-desktop)', `PING-${runId}`]]);
    assert.equal(woke.requests.length, 0);
    assert.equal((await cli('grok', 'listen', '--timeout', '1', '--interval', '0.3')).document.result.event, 'idle');
  });

  it('stops sessions from flooding each other', async () => {
    // The same text under a new key is not stored twice.
    const lobby = (await callTool(claude, 'list_conversations')).result.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    const first = await callTool(claude, 'send_message', { conversation_id: lobby, body: 'ok, thanks', idempotency_key: `echo-1-${runId}` });
    const echo = await callTool(claude, 'send_message', { conversation_id: lobby, body: 'ok, thanks', idempotency_key: `echo-2-${runId}` });
    assert.equal(echo.result.message_id, first.result.message_id);
    assert.equal(echo.result.duplicate_suppressed, true);

    const settings = await service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: 3 });
    assert.deepEqual([settings.open_mode, settings.message_rate_per_minute, settings.message_rate_per_hour], [true, 3, 120]);
    const send = (index) => cli('codex', 'call', 'send_message', '--arg', `conversation_id=${lobby}`, '--str', `body=round ${index}`, '--str', `idempotency_key=flood-${index}`);
    for (const index of [1, 2, 3]) {
      assert.equal((await send(index)).code, 0);
    }
    const refused = await send(4);
    assert.equal(refused.code, 1);
    assert.equal(refused.document.error.code, 'RATE_LIMITED');
    assert.equal(refused.document.error.details.limit, 3);
    assert.ok(refused.document.error.details.retry_after_seconds >= 1 && refused.document.error.details.retry_after_seconds <= 60);
    // The bot host is not limited: it answers for everyone.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const fromHost = await cli('grok', 'call', 'send_message', '--arg', `conversation_id=${lobby}`, '--str', `body=host round ${index}`, '--str', `idempotency_key=host-${index}`);
      assert.equal(fromHost.code, 0, `the bot host must not be rate limited (message ${index})`);
    }
    // The operator can lift the limits for any one session, and restore them.
    const codexId = (await cli('codex', 'call', 'get_session')).document.result.session_id;
    assert.equal((await service.admin('PUT', `/api/v1/sessions/${codexId}`, { rate_exempt: true })).rate_exempt, true);
    assert.equal((await send(4)).code, 0);
    assert.equal((await service.admin('PUT', `/api/v1/sessions/${codexId}`, { rate_exempt: false })).rate_exempt, false);
    assert.equal((await send(5)).document.error.code, 'RATE_LIMITED');
    // A retry of something already stored is still answered, and the operator is not limited.
    assert.equal((await send(1)).document.result.idempotent_replay, true);
    for (const index of [1, 2, 3, 4]) {
      await service.admin('POST', `/api/v1/conversations/${lobby}/messages`, { body: `operator ${index}` });
    }
    await assert.rejects(service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: -1 }), { code: 'INVALID_ARGUMENT' });
    await service.admin('PUT', '/api/v1/settings', { message_rate_per_minute: 12 });
    note('flood-control', { duplicateText: 'one message', limitPerMinute: 3, fourth: 'RATE_LIMITED', retryAfterSeconds: refused.document.error.details.retry_after_seconds, replayNotCounted: true, operatorLimited: false });
  });

  it('lets a client that is triggered from outside register and prove its own trigger', async () => {
    const hookUrl = `http://127.0.0.1:${hookServer.address().port}/routines/self`;
    // Without a registered trigger there is nothing to test.
    assert.equal((await cli('self-bot', 'wake', 'status')).document.result.hook, null);
    const none = await cli('self-bot', 'wake', 'test');
    assert.equal(none.code, 1);
    assert.equal(none.document.error.code, 'NO_WAKE_HOOK');

    // The key travels in a file and is in nothing the command prints.
    const set = await cli('self-bot', 'wake', 'set', '--url', hookUrl, '--key-file', file('self-key.txt', 'wk_self_key_456\n'));
    assert.equal(set.code, 0);
    assert.deepEqual([set.document.result.hook.enabled, set.document.result.hook.has_key, set.document.result.hook.include_text], [true, true, false]);
    assert.ok(!set.stdout.includes('wk_self_key_456'));
    // The same rule as for the operator: the address must be encrypted unless it is this machine.
    const plain = await cli('self-bot', 'wake', 'set', '--url', 'http://example.com/hook', '--key', 'k');
    assert.equal(plain.code, 1);
    assert.equal(plain.document.error.code, 'INVALID_ARGUMENT');
    assert.equal((await cli('self-bot', 'wake', 'bogus')).code, 2);

    // The whole way round: the signal starts a run, and that run asks for work on this machine.
    const before = hookCalls.length;
    routine = () => cli('self-bot', 'listen', '--timeout', '1', '--interval', '0.3');
    const proven = (await cli('self-bot', 'wake', 'test', '--wait', '25')).document.result;
    assert.deepEqual([proven.signal, proven.run_reached_this_machine, proven.working], ['accepted', true, true]);
    assert.equal(hookCalls.length, before + 1);
    assert.deepEqual([hookCalls.at(-1).path, hookCalls.at(-1).authorization, JSON.parse(hookCalls.at(-1).raw).test], ['/routines/self', 'Bearer wk_self_key_456', true]);

    // Accepted, but the run never reaches this machine: said as such, not as working.
    routine = undefined;
    const silent = (await cli('self-bot', 'wake', 'test', '--wait', '3')).document.result;
    assert.deepEqual([silent.signal, silent.run_reached_this_machine, silent.working], ['accepted', false, false]);
    assert.match(silent.verdict, /must run "listen"/);

    // Refused by the other side: the test says so and why.
    hookStatus = 401;
    const refused = (await cli('self-bot', 'wake', 'test', '--wait', '3')).document.result;
    assert.deepEqual([refused.signal, refused.detail, refused.working], ['refused', 'HTTP 401', false]);
    hookStatus = 200;

    // The operator sees the hook like any other and nothing shows its key; the session can take it away again.
    const state = await service.admin('GET', '/api/v1/bootstrap');
    assert.equal(state.wake_hooks.filter((entry) => entry.url === hookUrl).length, 1);
    assert.ok(!JSON.stringify(state).includes('wk_self_key_456'));
    assert.equal((await cli('self-bot', 'wake', 'remove')).document.result.hook, null);
    // It is not one of the tools, so no MCP client is offered it.
    assert.ok(!(await claude.listTools()).tools.some((tool) => tool.name === 'own_wake_hook'));
    note('own-trigger', { registeredBy: 'the session itself, through the command line', keyPrinted: false, provenBy: 'a run started by the signal asked for work on this machine', acceptedButSilentReportedAs: 'not working', refusedReportedWithReason: true });
  });

  it('keeps which Grok Bot the console prefill links open', async () => {
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.grok_bot_id, '');
    assert.equal((await service.admin('PUT', '/api/v1/settings', { grok_bot_id: 'bot_Ab-12' })).grok_bot_id, 'bot_Ab-12');
    // Only an id is accepted, so nothing else can be smuggled into the link.
    for (const bad of ['a b', 'x&text=y', 'https://example.com/b', 12]) {
      await assert.rejects(service.admin('PUT', '/api/v1/settings', { grok_bot_id: bad }), { code: 'INVALID_ARGUMENT' });
    }
    assert.equal((await service.admin('PUT', '/api/v1/settings', { grok_bot_id: '' })).grok_bot_id, '');
  });

  it('restarts on request and comes back with the same store', async () => {
    const before = await service.admin('GET', '/api/v1/bootstrap');
    // The console's button calls the gateway from the control service's origin; only that origin is let in.
    const preflight = await fetch(`${service.mcpBase}/restart`, { method: 'OPTIONS', headers: { origin: service.coreUrl, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-acm-admin-token' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), service.coreUrl);
    assert.equal((await fetch(`${service.mcpBase}/restart`, { method: 'POST' })).status, 401);

    const accepted = await fetch(`${service.mcpBase}/restart`, { method: 'POST', headers: { 'x-acm-admin-token': service.adminToken, connection: 'close' } });
    assert.equal(accepted.status, 200);
    assert.equal(await service.exited, 0, 'the old process must stop cleanly');
    await waitFor(async () => fetch(`${service.mcpBase}/healthz`).then((response) => response.ok, () => false), 20000, 'the replacement to answer');

    // Same store: nothing is lost and nothing has to be registered again.
    const afterwards = await service.admin('GET', '/api/v1/bootstrap');
    assert.equal(afterwards.event_watermark, before.event_watermark);
    assert.deepEqual(afterwards.sessions.map((entry) => [entry.session_id, entry.status]), before.sessions.map((entry) => [entry.session_id, entry.status]));
    assert.equal((await cli('grok', 'call', 'get_session')).document.result.session_id, sessions.grok);
    assert.equal((await callTool(claude, 'get_session')).result.session_id, sessions.claude);
    note('restart', { oldProcessExitCode: 0, cameBack: true, eventWatermarkKept: afterwards.event_watermark, sessionsKept: afterwards.sessions.length });
  });
});
