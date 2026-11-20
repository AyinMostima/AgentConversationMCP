// Contract test for the MCP transport (src/mcp) against the real service
// entry: initialize, tool discovery, pairing, send, read, acknowledge,
// duplicate requests, a lost response, permission denials, event catch-up
// after a dropped stream, and read-back after a service restart.
//
// Runs with default interconnection switched off, so the operator approval
// flow and strict member lists are what is under test here. The default-on
// behavior has its own spec: test/mcp/interconnect.spec.mjs.
//
// Run: node --test test/mcp/transport.spec.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callTool, connectClient, freePort, readEventStream, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
// Data and project paths deliberately contain a space and Chinese characters.
const base = mkdtempSync(join(tmpdir(), `acm \u6d4b\u8bd5 ${runId} `));
const dataDir = join(base, '\u6570\u636e \u76ee\u5f55');
const projectRoot = join(base, '\u9879\u76ee root');
const csvName = '\u6e05\u6d17\u7ed3\u679c.csv';
const csvBody = 'device,time_utc,value\nA1,2026-07-01T01:00:00Z,3.5\n';
mkdirSync(join(projectRoot, 'out'), { recursive: true });
writeFileSync(join(projectRoot, 'out', csvName), csvBody);

const evidence = { runId, startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (id, detail) => evidence.checks.push({ id, ...detail });

let service;
let ports;
const tokens = {};
const sessions = {};
const clients = {};
let conversationId;
const mark = (label) => `MARK-${runId}-${label}`;

async function pair(agentId, label) {
  const pairing = await service.admin('POST', '/api/v1/pairings', { agent_id: agentId, project_id: 'prj_contract', label });
  tokens[label] = pairing.token;
  sessions[label] = pairing.session_id;
  return pairing;
}
const messageCount = async () => (await service.admin('GET', `/api/v1/conversations/${conversationId}/messages?limit=200`)).messages.length;

describe('MCP transport contract', { concurrency: false }, () => {
  before(async () => {
    ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    await service.admin('PUT', '/api/v1/settings', { open_mode: false, message_rate_per_minute: 0, message_rate_per_hour: 0 });
  });

  after(async () => {
    for (const client of Object.values(clients)) {
      await client.close().catch(() => undefined);
    }
    const exitCode = service.child.exitCode === null ? await service.stop() : service.child.exitCode;
    evidence.finalExitCode = exitCode;
    evidence.finishedAt = new Date().toISOString();
    const out = join(repoRoot, 'test-output', 'reports');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'mcp-contract.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    // fs.rmSync silently leaves non-ASCII paths behind on Windows (Node 24); the async rm removes them.
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('rejects requests without a valid session credential', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const missing = await fetch(service.mcpUrl, { method: 'POST', headers, body: JSON.stringify(init) });
    const unknown = await fetch(service.mcpUrl, { method: 'POST', headers: { ...headers, authorization: 'Bearer acm_unknown' }, body: JSON.stringify(init) });
    const wrongMethod = await fetch(service.mcpUrl, { method: 'GET', headers: { authorization: 'Bearer acm_unknown' } });
    assert.equal(missing.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrongMethod.status, 405);
    const adminWithoutToken = await fetch(`${service.coreUrl}/api/v1/bootstrap`);
    assert.equal(adminWithoutToken.status, 401);
    note('unauthenticated', { missing: missing.status, unknown: unknown.status, get: wrongMethod.status, operatorApiWithoutToken: adminWithoutToken.status });
  });

  it('lets the operator create a project, agents and pairings', async () => {
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_contract', name: 'Contract', root_path: projectRoot });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_claude', provider: 'anthropic', client_kind: 'claude-desktop', display_name: 'Claude' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' });
    for (const [agent, label] of [['agt_claude', 'claude'], ['agt_codex', 'codex1'], ['agt_codex', 'codex2'], ['agt_codex', 'outsider']]) {
      const pairing = await pair(agent, label);
      assert.equal(pairing.status, 'pending');
      assert.match(pairing.token, /^acm_[0-9a-f]{48}$/);
    }
    const listed = await service.admin('GET', '/api/v1/sessions');
    assert.equal(listed.sessions.length, 4);
    assert.ok(!JSON.stringify(listed).includes(tokens.claude), 'plaintext credential must not be listed');
  });

  it('initializes and discovers the tool contract', async () => {
    clients.claude = await connectClient(service.mcpUrl, tokens.claude, 'claude-test');
    const info = clients.claude.getServerVersion();
    const tools = (await clients.claude.listTools()).tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.equal(info.name, 'agent-conversation-mcp');
    assert.deepEqual(names, [
      'acknowledge_message', 'bot_pull', 'bot_request', 'bot_requests', 'bot_respond', 'check_in', 'create_task', 'direct_message', 'forward_message', 'get_artifact', 'get_conversation', 'get_inbox', 'get_session',
      'list_conversations', 'list_tasks', 'propose_conversation', 'publish_artifact', 'read_messages', 'report_progress', 'request_pairing',
      'send_message', 'update_task',
    ]);
    const send = tools.find((tool) => tool.name === 'send_message');
    assert.deepEqual(send.inputSchema.required.sort(), ['body', 'conversation_id', 'idempotency_key']);
    assert.ok(!Object.keys(send.inputSchema.properties).some((name) => /sender|from|agent_id/.test(name)), 'no identity argument is accepted');
    note('initialize', { serverInfo: info, toolCount: names.length, names });
  });

  it('keeps an unapproved session out until the operator approves that instance', async () => {
    const pending = await callTool(clients.claude, 'get_session');
    assert.equal(pending.result.status, 'pending');
    assert.deepEqual(pending.result.conversations, []);
    assert.equal((await callTool(clients.claude, 'list_conversations')).code, 'NOT_PAIRED');
    await assert.rejects(service.admin('POST', `/api/v1/pairings/${sessions.claude}/approve`), { code: 'PAIRING_NOT_REQUESTED' });

    const requested = await callTool(clients.claude, 'request_pairing', { client_kind: 'claude-desktop', cwd: projectRoot, run_id: `pid-${process.pid}` });
    assert.equal(requested.result.status, 'requested');
    assert.equal(requested.result.claimed_cwd, projectRoot);
    const approved = await service.admin('POST', `/api/v1/pairings/${sessions.claude}/approve`);
    assert.equal(approved.status, 'active');
    assert.equal((await callTool(clients.claude, 'get_session')).result.status, 'active');

    for (const label of ['codex1', 'codex2', 'outsider']) {
      clients[label] = await connectClient(service.mcpUrl, tokens[label], `${label}-test`);
      await callTool(clients[label], 'request_pairing', { client_kind: 'codex-desktop', cwd: projectRoot });
      await service.admin('POST', `/api/v1/pairings/${sessions[label]}/approve`);
    }
    note('pairing', { sessions: Object.fromEntries(Object.entries(sessions).map(([label, id]) => [label, `${id.slice(0, 12)}...`])) });
  });

  it('applies the operator member list, including a version conflict', async () => {
    const conversation = await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_contract', task_code: 'DATA-014', title: 'CSV handoff' });
    conversationId = conversation.conversation_id;
    const members = ['claude', 'codex1', 'codex2'].map((label) => ({ session_id: sessions[label] }));
    const updated = await service.admin('PUT', `/api/v1/conversations/${conversationId}/members`, { expected_version: 1, members });
    assert.equal(updated.config_version, 2);
    await assert.rejects(service.admin('PUT', `/api/v1/conversations/${conversationId}/members`, { expected_version: 1, members: [] }), { code: 'VERSION_CONFLICT', status: 409 });
    const mine = await callTool(clients.codex1, 'list_conversations');
    assert.equal(mine.result.conversations.length, 1);
    assert.equal(mine.result.conversations[0].task_code, 'DATA-014');
  });

  it('sends, reads and acknowledges a shared message', async () => {
    const sent = await callTool(clients.claude, 'send_message', { conversation_id: conversationId, body: `${mark('shared')} clean CSV ready`, idempotency_key: `shared-${runId}` });
    assert.equal(sent.result.sequence, 1);
    assert.equal(sent.result.sender.session_id, sessions.claude);
    assert.equal(sent.result.recipients.length, 2);

    const page = await callTool(clients.codex1, 'read_messages', { conversation_id: conversationId, after_seq: 0 });
    assert.equal(page.result.messages.length, 1);
    assert.ok(page.result.messages[0].body.startsWith(mark('shared')));
    assert.equal(page.result.messages[0].your_receipt.status, 'read');
    assert.equal(page.result.next_cursor, 1);

    const ack = await callTool(clients.codex1, 'acknowledge_message', { message_id: sent.result.message_id });
    assert.equal(ack.result.status, 'acknowledged');
    const asSender = await callTool(clients.claude, 'read_messages', { conversation_id: conversationId });
    const receipts = Object.fromEntries(asSender.result.messages[0].recipients.map((receipt) => [receipt.session_id, receipt.status]));
    assert.equal(receipts[sessions.codex1], 'acknowledged');
    assert.equal(receipts[sessions.codex2], 'available');
    note('send-read-acknowledge', { messageId: sent.result.message_id, sequence: 1, receipts: { codex1: 'acknowledged', codex2: 'available' } });
  });

  it('delivers a directed message only to the named session of the same vendor', async () => {
    const secret = `${mark('directed')} only for codex window 1`;
    const sent = await callTool(clients.claude, 'send_message', { conversation_id: conversationId, body: secret, recipient_session_ids: [sessions.codex1], idempotency_key: `directed-${runId}` });
    assert.equal(sent.result.directed, true);
    const target = await callTool(clients.codex1, 'get_inbox');
    assert.ok(target.result.items.some((item) => item.body === secret));

    const sibling = await callTool(clients.codex2, 'read_messages', { conversation_id: conversationId, after_seq: 0 });
    assert.ok(!JSON.stringify(sibling.result).includes(mark('directed')));
    assert.equal(sibling.result.last_seq, 2);
    const siblingInbox = await callTool(clients.codex2, 'get_inbox');
    assert.ok(!JSON.stringify(siblingInbox.result).includes(mark('directed')));
    assert.equal((await callTool(clients.codex2, 'acknowledge_message', { message_id: sent.result.message_id })).code, 'NOT_RECIPIENT');
    const events = await service.admin('GET', '/api/v1/events?after=0&limit=1000');
    assert.ok(!JSON.stringify(events).includes(mark('directed')), 'events must not carry message bodies');
    note('directed-isolation', { messageId: sent.result.message_id, visibleTo: 'codex1', hiddenFrom: 'codex2' });
  });

  it('returns the original message for a duplicate request and refuses a changed one', async () => {
    const args = { conversation_id: conversationId, body: `${mark('dup')} handoff`, idempotency_key: `dup-${runId}` };
    const first = await callTool(clients.codex1, 'send_message', args);
    const countAfterFirst = await messageCount();
    const second = await callTool(clients.codex1, 'send_message', args);
    assert.equal(second.result.message_id, first.result.message_id);
    assert.equal(second.result.sequence, first.result.sequence);
    assert.equal(second.result.idempotent_replay, true);
    const changed = await callTool(clients.codex1, 'send_message', { ...args, body: `${mark('dup')} edited` });
    assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(changed.error.details.message_id, first.result.message_id);
    assert.equal(await messageCount(), countAfterFirst);
    note('duplicate-request', { messageId: first.result.message_id, replayed: true, conflictOnChange: true, messageCount: countAfterFirst });
  });

  it('stores exactly one message when the response is lost and the request is retried', async () => {
    const key = `lost-${runId}`;
    const args = { conversation_id: conversationId, body: `${mark('lost')} response never read`, recipient_session_ids: [sessions.codex2], idempotency_key: key };
    const countBefore = await messageCount();
    // Send the tool call over a raw socket and destroy it as soon as the request is written.
    await new Promise((done, fail) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'send_message', arguments: args } });
      const raw = httpRequest(service.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.claude}`, 'content-length': Buffer.byteLength(payload) },
      });
      raw.on('error', () => undefined);
      raw.end(payload, () => setTimeout(() => { raw.destroy(); done(); }, 30));
      setTimeout(() => fail(new Error('raw request was not written')), 5000).unref();
    });
    let committed = false;
    for (let attempt = 0; attempt < 50 && !committed; attempt += 1) {
      committed = (await messageCount()) === countBefore + 1;
      if (!committed) {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    assert.ok(committed, 'the write must commit even though nobody read the response');
    const stored = (await service.admin('GET', `/api/v1/conversations/${conversationId}/messages?limit=200`)).messages.find((message) => message.body.startsWith(mark('lost')));

    const retry = await callTool(clients.claude, 'send_message', args);
    assert.equal(retry.result.message_id, stored.message_id);
    assert.equal(retry.result.idempotent_replay, true);
    assert.deepEqual(retry.result.recipients.map((receipt) => receipt.session_id), [sessions.codex2]);
    assert.equal(await messageCount(), countBefore + 1);
    note('response-lost-retry', { committedBeforeRetry: true, messageId: stored.message_id, sequence: stored.sequence, recipient: 'codex2', messageCount: countBefore + 1 });
  });

  it('refuses sessions that are not members and ignores identity arguments', async () => {
    assert.equal((await callTool(clients.outsider, 'read_messages', { conversation_id: conversationId })).code, 'NOT_MEMBER');
    assert.equal((await callTool(clients.outsider, 'send_message', { conversation_id: conversationId, body: 'let me in', idempotency_key: `out-${runId}` })).code, 'NOT_MEMBER');
    assert.equal((await callTool(clients.outsider, 'get_conversation', { conversation_id: conversationId })).code, 'NOT_MEMBER');
    assert.deepEqual((await callTool(clients.outsider, 'list_conversations')).result.conversations, []);
    assert.equal((await callTool(clients.codex2, 'send_message', { conversation_id: conversationId, body: 'to outsider', recipient_session_ids: [sessions.outsider], idempotency_key: `bad-${runId}` })).code, 'INVALID_RECIPIENT');
    // An identity argument is not part of the contract: it is dropped and the caller stays the author.
    const forged = await clients.codex2.callTool({ name: 'send_message', arguments: { conversation_id: conversationId, body: 'forged', sender_session_id: sessions.claude, idempotency_key: `forge-${runId}` } }).catch((error) => ({ rejected: String(error) }));
    const authors = (await service.admin('GET', `/api/v1/conversations/${conversationId}/messages?limit=200`)).messages.filter((message) => message.body === 'forged').map((message) => message.sender.session_id);
    assert.ok(authors.every((author) => author === sessions.codex2), 'a forged sender must never be recorded');
    note('permission-denied', { outsiderRead: 'NOT_MEMBER', outsiderSend: 'NOT_MEMBER', nonMemberRecipient: 'INVALID_RECIPIENT', forgedSenderRecordedAs: authors.length === 0 ? 'rejected' : 'caller', forged: forged.rejected ?? forged.isError ?? 'accepted-as-caller' });
  });

  it('records progress and a verified artifact reference', async () => {
    const digest = createHash('sha256').update(csvBody).digest('hex');
    const published = await callTool(clients.claude, 'publish_artifact', { conversation_id: conversationId, name: 'clean readings', relative_path: `out\\${csvName}`, direction: 'output', format: 'csv', row_count: 1, timezone: 'UTC', idempotency_key: `art-${runId}` });
    assert.equal(published.result.payload.sha256, digest);
    assert.equal(published.result.payload.relative_path, `out/${csvName}`);
    const artifact = await callTool(clients.codex1, 'get_artifact', { artifact_id: published.result.payload.artifact_id });
    assert.equal(artifact.result.current.matches_recorded_sha256, true);
    assert.equal((await callTool(clients.claude, 'publish_artifact', { conversation_id: conversationId, name: 'escape', relative_path: '..\\..\\Windows\\win.ini', direction: 'input', idempotency_key: `esc-${runId}` })).code, 'PATH_OUTSIDE_PROJECT');
    const progress = await callTool(clients.codex1, 'report_progress', { conversation_id: conversationId, stage: 'verify', run_state: 'completed', summary: 'row count and digest verified', percent: 100, artifact_ids: [published.result.payload.artifact_id], idempotency_key: `prg-${runId}` });
    assert.equal(progress.result.kind, 'progress');
    assert.equal(progress.result.payload.source, 'agent_reported');
    note('progress-artifact', { artifactId: published.result.payload.artifact_id, sha256: digest, verifiedByReader: true, outsidePathRejected: 'PATH_OUTSIDE_PROJECT' });
  });

  it('coordinates through the goal, the task board, check_in, forwarding and a proposal', async () => {
    // The operator sets the overall goal; members read it through check_in.
    const goalText = `${mark('goal')} deliver a verified clean CSV`;
    assert.equal((await service.admin('PUT', `/api/v1/conversations/${conversationId}/goal`, { goal: goalText })).goal, goalText);

    // One board for everyone: a second agent adding the same task gets the existing one.
    const title = `Verify output ${runId}`;
    const created = await callTool(clients.codex1, 'create_task', { conversation_id: conversationId, title, assignee_session_id: 'me' });
    assert.equal(created.result.number, 1);
    assert.equal(created.result.status, 'doing');
    const duplicate = await callTool(clients.claude, 'create_task', { conversation_id: conversationId, title });
    assert.equal(duplicate.result.task_id, created.result.task_id);
    assert.equal(duplicate.result.already_exists, true);
    // The task is held by codex1: a second session claiming it is told so instead of overwriting.
    const second = await callTool(clients.claude, 'update_task', { task_id: created.result.task_id, assignee_session_id: 'me' });
    assert.equal(second.code, 'ALREADY_CLAIMED');
    assert.equal(second.error.details.current.assignee.session_id, sessions.codex1);
    assert.equal(second.error.details.current.version, 1);

    // check_in returns goal, board and only what others wrote since the last check.
    const first = await callTool(clients.claude, 'check_in', { conversation_id: conversationId });
    const entry = first.result.conversations[0];
    assert.equal(entry.goal, goalText);
    assert.equal(entry.tasks.length, 1);
    assert.equal(entry.tasks[0].assignee.session_id, sessions.codex1);
    assert.ok(entry.new_messages.every((message) => message.sender.session_id !== sessions.claude), 'own messages are not repeated');
    assert.equal((await callTool(clients.claude, 'check_in', { conversation_id: conversationId })).result.conversations[0].new_messages.length, 0);
    const news = `${mark('news')} verification started`;
    await callTool(clients.codex1, 'send_message', { conversation_id: conversationId, body: news, idempotency_key: `news-${runId}` });
    const later = await callTool(clients.claude, 'check_in');
    assert.deepEqual(later.result.conversations.find((item) => item.conversation_id === conversationId).new_messages.map((message) => message.body), [news]);

    // Two agents cannot silently overwrite each other's task update.
    const noted = await callTool(clients.codex1, 'update_task', { task_id: created.result.task_id, note: 'row count matches', expected_version: 1 });
    assert.equal(noted.result.version, 2);
    const stale = await callTool(clients.claude, 'update_task', { task_id: created.result.task_id, status: 'cancelled', expected_version: 1 });
    assert.equal(stale.code, 'VERSION_CONFLICT');
    assert.equal(stale.error.details.current.note, 'row count matches');
    const done = await callTool(clients.codex1, 'update_task', { task_id: created.result.task_id, status: 'done', note: 'verified', expected_version: 2 });
    assert.equal(done.result.status, 'done');
    assert.deepEqual((await callTool(clients.claude, 'list_tasks', { conversation_id: conversationId })).result.tasks, []);
    assert.equal((await service.admin('GET', `/api/v1/conversations/${conversationId}/tasks`)).tasks.length, 1);
    assert.equal((await callTool(clients.outsider, 'list_tasks', { conversation_id: conversationId })).code, 'NOT_MEMBER');

    // Forwarding passes a message on with its origin; a non-reader cannot forward it.
    const source = await callTool(clients.claude, 'send_message', { conversation_id: conversationId, body: `${mark('fwd')} please pass this on`, recipient_session_ids: [sessions.codex1], idempotency_key: `fwd-src-${runId}` });
    assert.equal((await callTool(clients.codex2, 'forward_message', { message_id: source.result.message_id, idempotency_key: `fwd-x-${runId}` })).code, 'NOT_FOUND');
    const relayed = await callTool(clients.codex1, 'forward_message', { message_id: source.result.message_id, recipient_session_ids: [sessions.codex2], note: 'relaying as asked', idempotency_key: `fwd-${runId}` });
    assert.equal(relayed.result.forwarded_from, source.result.message_id);
    const seen = (await callTool(clients.codex2, 'check_in', { conversation_id: conversationId })).result.conversations[0].new_messages.find((message) => message.message_id === relayed.result.message_id);
    assert.equal(seen.body, `${mark('fwd')} please pass this on`);
    assert.equal(seen.payload.forwarded.sender_display_name, 'Claude');
    assert.equal(seen.payload.forwarded.note, 'relaying as asked');

    // An agent may only propose a conversation; it exists once the operator approves.
    const proposal = await callTool(clients.codex2, 'propose_conversation', { task_code: `PROP-${runId}`, title: 'Follow-up review', goal: 'Explain the spike', member_session_ids: [sessions.claude] });
    assert.equal(proposal.result.status, 'pending');
    assert.equal((await callTool(clients.codex2, 'list_conversations')).result.conversations.length, 1);
    const pending = (await service.admin('GET', '/api/v1/bootstrap')).proposals.filter((item) => item.status === 'pending');
    assert.equal(pending.length, 1);
    const approved = await service.admin('POST', `/api/v1/proposals/${proposal.result.proposal_id}/approve`);
    assert.equal(approved.status, 'approved');
    const after = await callTool(clients.codex2, 'check_in');
    assert.equal(after.result.conversations.length, 2);
    assert.equal(after.result.proposals[0].status, 'approved');
    assert.equal(after.result.conversations.find((item) => item.conversation_id === approved.conversation_id).goal, 'Explain the spike');
    assert.ok((await callTool(clients.claude, 'get_session')).result.project_sessions.some((item) => item.session_id === sessions.codex1));
    note('collaboration', { goalReadByMember: true, duplicateTaskMerged: true, checkInSecondCallNew: 0, secondClaim: 'ALREADY_CLAIMED', staleTaskUpdate: 'VERSION_CONFLICT', forwardedWithOrigin: true, forwardByNonReader: 'NOT_FOUND', proposal: 'pending -> approved', conversationsAfterApproval: 2 });
  });

  it('streams committed events and replays exactly the missed ones after a dropped connection', async () => {
    const snapshot = await service.admin('GET', '/api/v1/bootstrap');
    const firstBatch = await readEventStream({ ...service, lastEventId: 0, count: snapshot.event_watermark });
    assert.equal(firstBatch.length, snapshot.event_watermark);
    assert.deepEqual(firstBatch.map((event) => event.event_id), Array.from({ length: snapshot.event_watermark }, (_, index) => index + 1));
    const lastSeen = firstBatch.at(-1).event_id;

    // The stream is closed now. Three more messages are committed while nobody listens.
    const during = [];
    for (const index of [1, 2, 3]) {
      during.push((await callTool(clients.codex2, 'send_message', { conversation_id: conversationId, body: `${mark(`offline-${index}`)}`, idempotency_key: `offline-${index}-${runId}` })).result.message_id);
    }
    const resumed = await readEventStream({ ...service, lastEventId: lastSeen, count: 3 });
    assert.deepEqual(resumed.map((event) => event.entity_id), during);
    assert.deepEqual(resumed.map((event) => event.event_id), [lastSeen + 1, lastSeen + 2, lastSeen + 3]);
    assert.ok(resumed.every((event) => event.event_type === 'message.created'));
    const polled = await service.admin('GET', `/api/v1/events?after=${lastSeen}&limit=100`);
    assert.deepEqual(polled.events.map((event) => event.event_id), resumed.map((event) => event.event_id));

    // A live subscriber receives an event committed after it connected.
    const live = readEventStream({ ...service, lastEventId: polled.watermark, count: 1, timeoutMs: 5000 });
    await new Promise((done) => setTimeout(done, 300));
    const liveMessage = await callTool(clients.claude, 'send_message', { conversation_id: conversationId, body: mark('live'), idempotency_key: `live-${runId}` });
    const liveEvents = await live;
    assert.equal(liveEvents.length, 1);
    assert.equal(liveEvents[0].entity_id, liveMessage.result.message_id);
    note('event-catch-up', { replayedFromStart: firstBatch.length, lastSeenBeforeDrop: lastSeen, committedWhileDisconnected: 3, replayedAfterResume: resumed.map((event) => event.event_id), duplicates: 0, liveDelivered: true });
  });

  it('reads back identical history, receipts and idempotency after a service restart', async () => {
    const before = await service.admin('GET', `/api/v1/conversations/${conversationId}/messages?limit=200`);
    const bootBefore = await service.admin('GET', '/api/v1/bootstrap');
    for (const client of Object.values(clients)) {
      await client.close().catch(() => undefined);
    }
    const stopCode = await service.stop();
    assert.equal(stopCode, 0);
    await assert.rejects(fetch(`${service.mcpBase}/healthz`), 'the endpoint must be down between runs');

    service = await startService({ dataDir, ...ports });
    const afterRestart = await service.admin('GET', `/api/v1/conversations/${conversationId}/messages?limit=200`);
    assert.deepEqual(afterRestart, before);
    const bootAfter = await service.admin('GET', '/api/v1/bootstrap');
    assert.equal(bootAfter.event_watermark, bootBefore.event_watermark);
    assert.deepEqual(bootAfter.sessions.map((session) => [session.session_id, session.status]), bootBefore.sessions.map((session) => [session.session_id, session.status]));

    // The same credentials still work and see the same visible history.
    clients.codex1 = await connectClient(service.mcpUrl, tokens.codex1, 'codex1-after-restart');
    clients.codex2 = await connectClient(service.mcpUrl, tokens.codex2, 'codex2-after-restart');
    clients.claude = await connectClient(service.mcpUrl, tokens.claude, 'claude-after-restart');
    const visibleToCodex1 = await callTool(clients.codex1, 'read_messages', { conversation_id: conversationId, after_seq: 0, limit: 200 });
    const expectedForCodex1 = before.messages.filter((message) => !message.directed || message.sender.session_id === sessions.codex1 || message.recipients.some((receipt) => receipt.session_id === sessions.codex1));
    assert.deepEqual(visibleToCodex1.result.messages.map((message) => [message.message_id, message.sequence, message.body]), expectedForCodex1.map((message) => [message.message_id, message.sequence, message.body]));
    assert.ok(!JSON.stringify((await callTool(clients.codex2, 'read_messages', { conversation_id: conversationId, limit: 200 })).result).includes(mark('directed')));

    // A retry of a pre-restart request resolves to the stored message; a new one continues the sequence.
    const replay = await callTool(clients.codex1, 'send_message', { conversation_id: conversationId, body: `${mark('dup')} handoff`, idempotency_key: `dup-${runId}` });
    assert.equal(replay.result.idempotent_replay, true);
    const next = await callTool(clients.claude, 'send_message', { conversation_id: conversationId, body: mark('after-restart'), idempotency_key: `after-${runId}` });
    assert.equal(next.result.sequence, before.last_seq + 1);
    note('restart-readback', { stopExitCode: stopCode, messagesBefore: before.messages.length, messagesAfter: afterRestart.messages.length, identical: true, eventWatermark: bootAfter.event_watermark, nextSequence: next.result.sequence });
  });

  it('cuts off a revoked credential at the transport', async () => {
    const revoked = await service.admin('POST', `/api/v1/sessions/${sessions.codex2}/revoke`);
    assert.equal(revoked.status, 'revoked');
    await assert.rejects(clients.codex2.callTool({ name: 'get_session', arguments: {} }));
    const direct = await fetch(service.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.codex2}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(direct.status, 401);
    assert.equal((await callTool(clients.codex1, 'get_session')).result.status, 'active');
    note('revocation', { revokedSessionHttpStatus: direct.status, otherSessionsUnaffected: true });
  });
});
