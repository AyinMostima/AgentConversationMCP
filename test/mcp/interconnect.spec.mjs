// Contract test for default interconnection against the real service entry:
// a session that reports itself is usable without approval, every linked
// session of a project shares one lobby, two sessions talk in a private direct
// conversation, the operator can take a session out and put it back, and
// switching interconnection off restores the approval step.
//
// Run: node --test test/mcp/interconnect.spec.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callTool, connectClient, freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-open-${runId}-`));
const dataDir = join(base, 'data');
const evidence = { runId, startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (id, detail) => evidence.checks.push({ id, ...detail });
const mark = (label) => `OPEN-${runId}-${label}`;

let service;
const tokens = {};
const sessions = {};
const clients = {};
let lobbyId;
let directId;
let namedLobbyId;

async function pair(label, project = 'prj_open', agent = 'agt_codex') {
  const pairing = await service.admin('POST', '/api/v1/pairings', { agent_id: agent, project_id: project, label });
  tokens[label] = pairing.token;
  sessions[label] = pairing.session_id;
  clients[label] = await connectClient(service.mcpUrl, pairing.token, `${label}-test`);
  return pairing;
}
const join_ = (label, kind = 'codex-desktop') => callTool(clients[label], 'request_pairing', { client_kind: kind });
const conversationsOf = async (label) => (await callTool(clients[label], 'check_in')).result.conversations;

describe('default interconnection', { concurrency: false }, () => {
  before(async () => {
    service = await startService({ dataDir, mcpPort: await freePort(), corePort: await freePort() });
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_open', name: 'Open project' });
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_other', name: 'Other project' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_claude', provider: 'anthropic', client_kind: 'claude-desktop', display_name: 'Claude' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' });
  });

  after(async () => {
    for (const client of Object.values(clients)) {
      await client.close().catch(() => undefined);
    }
    evidence.finalExitCode = service.child.exitCode === null ? await service.stop() : service.child.exitCode;
    evidence.finishedAt = new Date().toISOString();
    const out = join(repoRoot, 'test-output', 'reports');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'mcp-interconnect.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('is on for a new installation and makes a reporting session usable without approval', async () => {
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.open_mode, true);
    const pairing = await pair('claude', 'prj_open', 'agt_claude');
    assert.equal(pairing.status, 'pending');
    // The credential alone unlocks nothing; the instance still reports itself once.
    assert.equal((await callTool(clients.claude, 'check_in')).code, 'NOT_PAIRED');

    const joined = await join_('claude', 'claude-desktop');
    assert.equal(joined.result.status, 'active');
    const session = (await callTool(clients.claude, 'get_session')).result;
    assert.deepEqual(session.interconnection, { open_mode: true, linked: true });
    assert.equal(session.conversations.length, 1);
    assert.equal(session.conversations[0].kind, 'lobby');
    lobbyId = session.conversations[0].conversation_id;

    const listed = (await service.admin('GET', '/api/v1/sessions')).sessions.find((item) => item.session_id === sessions.claude);
    assert.equal(listed.status, 'active');
    assert.equal(listed.linked, true);
    const approvals = (await service.admin('GET', '/api/v1/events?after=0&limit=1000')).events.filter((event) => event.event_type === 'pairing.approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].payload.automatic, true);
    note('automatic-pairing', { before: 'pending', afterRequestPairing: 'active', operatorApprovalCalls: 0, lobbyJoined: true });
  });

  it('puts every linked session of a project into one lobby and keeps projects apart', async () => {
    for (const label of ['codex1', 'codex2']) {
      await pair(label);
      assert.equal((await join_(label)).result.status, 'active');
    }
    await pair('elsewhere', 'prj_other');
    await join_('elsewhere');

    const said = await callTool(clients.claude, 'send_message', { conversation_id: lobbyId, body: `${mark('lobby')} hello everyone`, idempotency_key: `lobby-${runId}` });
    assert.equal(said.result.sequence, 1);
    assert.deepEqual(said.result.recipients.map((receipt) => receipt.session_id).sort(), [sessions.codex1, sessions.codex2].sort());
    for (const label of ['codex1', 'codex2']) {
      const entries = await conversationsOf(label);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].conversation_id, lobbyId);
      assert.equal(entries[0].kind, 'lobby');
      assert.deepEqual(entries[0].new_messages.map((message) => message.body), [`${mark('lobby')} hello everyone`]);
    }
    // The other project has its own lobby and cannot reach this one.
    const other = await conversationsOf('elsewhere');
    assert.equal(other.length, 1);
    assert.notEqual(other[0].conversation_id, lobbyId);
    assert.equal(other[0].new_messages.length, 0);
    assert.equal((await callTool(clients.elsewhere, 'read_messages', { conversation_id: lobbyId })).code, 'NOT_MEMBER');
    const lobby = await service.admin('GET', `/api/v1/conversations/${lobbyId}`);
    assert.equal(lobby.members.length, 3);
    note('lobby', { members: lobby.members.length, messageSeenBy: ['codex1', 'codex2'], otherProjectRead: 'NOT_MEMBER' });
  });

  it('lets two sessions talk in a direct conversation nobody else can read', async () => {
    const roster = (await callTool(clients.claude, 'check_in')).result.project_sessions;
    assert.deepEqual(roster.map((item) => item.session_id).sort(), [sessions.claude, sessions.codex1, sessions.codex2].sort());

    const secret = `${mark('direct')} between the two of us`;
    const args = { to_session_id: sessions.codex1, body: secret, idempotency_key: `dm-${runId}` };
    const sent = await callTool(clients.claude, 'direct_message', args);
    assert.equal(sent.result.sequence, 1);
    assert.equal(sent.result.sender.session_id, sessions.claude);
    assert.deepEqual(sent.result.recipients.map((receipt) => receipt.session_id), [sessions.codex1]);
    directId = sent.result.conversation_id;
    assert.notEqual(directId, lobbyId);
    // A retry resolves to the stored message instead of a second one.
    const replay = await callTool(clients.claude, 'direct_message', args);
    assert.equal(replay.result.message_id, sent.result.message_id);
    assert.equal(replay.result.idempotent_replay, true);

    const received = (await conversationsOf('codex1')).find((item) => item.conversation_id === directId);
    assert.equal(received.kind, 'direct');
    assert.deepEqual(received.with.map((item) => item.session_id), [sessions.claude]);
    assert.deepEqual(received.new_messages.map((message) => message.body), [secret]);
    // The answer lands in the same conversation, whoever opens it.
    const answer = await callTool(clients.codex1, 'direct_message', { to_session_id: sessions.claude, body: `${mark('direct')} got it`, reply_to_message_id: sent.result.message_id, idempotency_key: `dm-back-${runId}` });
    assert.equal(answer.result.conversation_id, directId);
    assert.equal(answer.result.sequence, 2);

    // The third session of the same project and the operator event log see none of it.
    assert.ok(!JSON.stringify(await conversationsOf('codex2')).includes(mark('direct')));
    assert.equal((await callTool(clients.codex2, 'read_messages', { conversation_id: directId })).code, 'NOT_MEMBER');
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/events?after=0&limit=1000')).includes(mark('direct')));

    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: sessions.claude, body: 'x', idempotency_key: `self-${runId}` })).code, 'INVALID_ARGUMENT');
    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: sessions.elsewhere, body: 'x', idempotency_key: `cross-${runId}` })).code, 'INVALID_RECIPIENT');
    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: 'ses_missing', body: 'x', idempotency_key: `none-${runId}` })).code, 'INVALID_RECIPIENT');
    note('direct', { conversation: 'one per pair', replySameConversation: true, retryReplayed: true, thirdSessionRead: 'NOT_MEMBER', otherProject: 'INVALID_RECIPIENT' });
  });

  it('lets the operator take one session out of the interconnection and put it back', async () => {
    await callTool(clients.codex2, 'direct_message', { to_session_id: sessions.claude, body: `${mark('pre')} before unlink`, idempotency_key: `pre-${runId}` });
    assert.equal((await conversationsOf('codex2')).length, 2);

    const off = await service.admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: false });
    assert.equal(off.linked, false);
    assert.equal(off.status, 'active');
    assert.deepEqual(await conversationsOf('codex2'), []);
    assert.deepEqual((await callTool(clients.codex2, 'get_session')).result.interconnection, { open_mode: true, linked: false });
    assert.equal((await callTool(clients.codex2, 'direct_message', { to_session_id: sessions.claude, body: 'x', idempotency_key: `off-a-${runId}` })).code, 'NOT_LINKED');
    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: sessions.codex2, body: 'x', idempotency_key: `off-b-${runId}` })).code, 'NOT_LINKED');
    assert.equal((await callTool(clients.codex2, 'read_messages', { conversation_id: lobbyId })).code, 'NOT_MEMBER');
    const seenByPeer = (await callTool(clients.claude, 'check_in')).result.project_sessions.find((item) => item.session_id === sessions.codex2);
    assert.equal(seenByPeer.linked, false);
    // The others are untouched.
    assert.equal((await conversationsOf('codex1')).length, 2);

    const on = await service.admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: true });
    assert.equal(on.linked, true);
    const back = await conversationsOf('codex2');
    assert.deepEqual(back.map((item) => item.kind), ['lobby']);
    const again = await callTool(clients.codex2, 'direct_message', { to_session_id: sessions.claude, body: `${mark('post')} after relink`, idempotency_key: `post-${runId}` });
    assert.equal(again.result.sequence, 2);

    await assert.rejects(service.admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: 'yes' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(service.admin('PUT', '/api/v1/sessions/ses_missing', { linked: false }), { code: 'NOT_FOUND' });
    note('link-switch', { unlinkedConversations: 0, directWhileUnlinked: 'NOT_LINKED', lobbyWhileUnlinked: 'NOT_MEMBER', relinked: ['lobby'], directHistoryKept: true });
  });

  it('pairs in a project that already has a task conversation called LOBBY', async () => {
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_named', name: 'Named' });
    const named = await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_named', task_code: 'LOBBY', title: 'A task that happens to be called LOBBY' });
    for (const label of ['named1', 'named2']) {
      await pair(label, 'prj_named');
      assert.equal((await join_(label)).result.status, 'active');
    }
    const entries = await conversationsOf('named1');
    assert.deepEqual(entries.map((item) => item.kind), ['lobby']);
    assert.notEqual(entries[0].conversation_id, named.conversation_id);
    namedLobbyId = entries[0].conversation_id;
    await assert.rejects(service.admin('POST', '/api/v1/conversations', { project_id: 'prj_named', task_code: '@lobby', title: 'x' }), { code: 'INVALID_ARGUMENT' });
    assert.equal((await callTool(clients.named1, 'propose_conversation', { task_code: '@dm-0000000000000000', title: 'x' })).code, 'INVALID_ARGUMENT');
    note('reserved-codes', { topicCalledLobby: 'kept', pairing: 'active', lobby: 'separate conversation', reservedCode: 'INVALID_ARGUMENT' });
  });

  it('keeps check_in complete after a read far past the end', async () => {
    const over = await callTool(clients.named2, 'read_messages', { conversation_id: namedLobbyId, after_seq: 1000 });
    assert.deepEqual(over.result.messages, []);
    assert.equal(over.result.next_cursor, 0);
    const sent = await callTool(clients.named1, 'send_message', { conversation_id: namedLobbyId, body: mark('after-overshoot'), idempotency_key: `over-${runId}` });
    assert.equal(sent.result.sequence, 1);
    const seen = (await conversationsOf('named2')).find((item) => item.conversation_id === namedLobbyId).new_messages;
    assert.deepEqual(seen.map((message) => message.body), [mark('after-overshoot')]);
    note('cursor-overshoot', { afterSeq: 1000, nextCursor: 0, nextMessageSequence: 1, seenByCheckIn: true });
  });

  it('never gives back access the operator took away', async () => {
    const members = (labels) => labels.map((label) => ({ session_id: sessions[label] }));
    const versionOf = async (id) => (await service.admin('GET', `/api/v1/conversations/${id}`)).config_version;
    const put = async (id, labels, version) => service.admin('PUT', `/api/v1/conversations/${id}/members`, { expected_version: version ?? await versionOf(id), members: members(labels) });

    // A third session cannot be added to a direct conversation to read its history.
    await assert.rejects(put(directId, ['claude', 'codex1', 'codex2']), { code: 'DIRECT_MEMBERS_FIXED' });
    assert.equal((await callTool(clients.codex2, 'read_messages', { conversation_id: directId })).code, 'NOT_MEMBER');

    // Removed from a direct conversation: the peer writing again does not add it back.
    await put(directId, ['claude']);
    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: sessions.codex1, body: 'x', idempotency_key: `closed-a-${runId}` })).code, 'DIRECT_CLOSED');
    assert.equal((await callTool(clients.codex1, 'direct_message', { to_session_id: sessions.claude, body: 'x', idempotency_key: `closed-b-${runId}` })).code, 'DIRECT_CLOSED');
    assert.equal((await callTool(clients.codex1, 'read_messages', { conversation_id: directId })).code, 'NOT_MEMBER');
    assert.ok(!(await conversationsOf('codex1')).some((item) => item.conversation_id === directId));
    const closed = await service.admin('GET', `/api/v1/conversations/${directId}`);
    assert.deepEqual(closed.former_members.map((item) => [item.session_id, item.removed_reason]), [[sessions.codex1, 'operator']]);

    // A member list loaded before a session was unlinked cannot be saved back.
    const staleVersion = await versionOf(lobbyId);
    await service.admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: false });
    await assert.rejects(put(lobbyId, ['claude', 'codex1', 'codex2'], staleVersion), { code: 'VERSION_CONFLICT' });
    await assert.rejects(put(lobbyId, ['claude', 'codex1', 'codex2']), { code: 'NOT_LINKED' });
    assert.equal((await callTool(clients.codex2, 'read_messages', { conversation_id: lobbyId })).code, 'NOT_MEMBER');

    // Only the operator restores: relink the session, put the direct conversation back.
    await service.admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: true });
    await put(directId, ['claude', 'codex1']);
    assert.equal((await callTool(clients.codex1, 'read_messages', { conversation_id: directId })).result.messages.length, 2);
    note('removal-stays', { thirdIntoDirect: 'DIRECT_MEMBERS_FIXED', directAfterRemoval: 'DIRECT_CLOSED', removedReads: 'NOT_MEMBER', staleMemberList: 'VERSION_CONFLICT', unlinkedIntoLobby: 'NOT_LINKED', restoredBy: 'operator' });
  });

  it('restores operator approval for new sessions when interconnection is switched off', async () => {
    assert.equal((await service.admin('PUT', '/api/v1/settings', { open_mode: false })).open_mode, false);
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.open_mode, false);
    await assert.rejects(service.admin('PUT', '/api/v1/settings', { open_mode: 1 }), { code: 'INVALID_ARGUMENT' });

    await pair('late');
    assert.equal((await join_('late')).result.status, 'requested');
    assert.equal((await callTool(clients.late, 'check_in')).code, 'NOT_PAIRED');
    await service.admin('POST', `/api/v1/pairings/${sessions.late}/approve`);
    // Approved, but nothing is joined automatically while the switch is off.
    assert.deepEqual(await conversationsOf('late'), []);
    assert.equal((await callTool(clients.claude, 'direct_message', { to_session_id: sessions.late, body: 'x', idempotency_key: `late-${runId}` })).code, 'OPEN_MODE_OFF');
    // Conversations that already exist keep working.
    const kept = await callTool(clients.claude, 'direct_message', { to_session_id: sessions.codex1, body: `${mark('kept')} still here`, idempotency_key: `kept-${runId}` });
    assert.equal(kept.result.conversation_id, directId);
    assert.equal((await conversationsOf('codex1')).length, 2);

    await service.admin('PUT', '/api/v1/settings', { open_mode: true });
    assert.deepEqual((await conversationsOf('late')).map((item) => item.kind), ['lobby']);
    const changes = (await service.admin('GET', '/api/v1/events?after=0&limit=1000')).events.filter((event) => event.event_type === 'settings.changed');
    assert.deepEqual(changes.map((event) => event.payload.open_mode), [false, true]);
    // A bridge that registers itself follows the same switch: it waits for approval while it is off.
    const selfToken = `acm_${randomBytes(24).toString('hex')}`;
    const enrollSelf = async () => (await fetch(`${service.coreUrl}/internal/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${selfToken}` }, body: JSON.stringify({ client: 'antigravity', project_id: 'prj_open' }) })).json();
    await service.admin('PUT', '/api/v1/settings', { open_mode: false });
    const waiting = await enrollSelf();
    assert.equal(waiting.result.status, 'requested');
    await service.admin('PUT', '/api/v1/settings', { open_mode: true });
    assert.equal((await enrollSelf()).result.status, 'active');
    assert.equal((await fetch(`${service.coreUrl}/internal/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer acm_guessable' }, body: '{"client":"codex"}' })).status, 400);

    // A revoked credential leaves the lobby as well.
    await service.admin('POST', `/api/v1/sessions/${sessions.late}/revoke`);
    const lobby = await service.admin('GET', `/api/v1/conversations/${lobbyId}`);
    assert.ok(!lobby.members.some((member) => member.session_id === sessions.late));
    assert.equal(lobby.members.length, 4);
    note('switch-off', { newSessionAfterRequest: 'requested', beforeApproval: 'NOT_PAIRED', newDirect: 'OPEN_MODE_OFF', existingDirect: 'kept', lobbyAfterSwitchOn: true });
  });
});
