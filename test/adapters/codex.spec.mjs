// Real-client test for the Codex adapter path (L1 shared read/write): a real
// Codex CLI session connects to the running service over Streamable HTTP MCP,
// pairs itself, reads a directed message, acknowledges it, replies with a
// nonce it could only learn from that message, repeats the send, and reads the
// history back after a service restart. The peer is an MCP SDK identity.
//
// Codex is configured per invocation with -c overrides and an environment
// variable for the credential; ~/.codex/config.toml is not modified.
//
// A Codex turn can stall on its own model backend (network), independent of
// this service. Each step is therefore re-entrant: it is judged by the state
// the service recorded, and retried when a turn ends without reaching it.
// Every attempt, including stalled ones, is written to the evidence file.
//
// Run: node --test test/adapters/codex.spec.mjs   (needs a logged-in Codex CLI)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callTool, connectClient, freePort, repoRoot, startService } from '../support/service.mjs';

const codexEntry = process.env.ACM_CODEX_ENTRY ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const TURN_TIMEOUT_MS = 150000;
const MAX_ATTEMPTS = 3;
const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-codex-${runId}-`));
const dataDir = join(base, 'data');
const workDir = join(base, 'work');
mkdirSync(workDir, { recursive: true });

const evidence = { runId, startedAt: new Date().toISOString(), client: 'codex-cli', steps: [] };
let service;
let ports;
let peer;
const ids = {};
const tokens = {};

/** Names of MCP servers in the user's Codex config, so each run can disable them. */
function userServerNames() {
  const file = join(process.env.USERPROFILE ?? '', '.codex', 'config.toml');
  if (!existsSync(file)) {
    return [];
  }
  return [...readFileSync(file, 'utf8').matchAll(/^\[mcp_servers\.([^.\]]+)\]/gm)].map((match) => match[1]);
}

/** Run one non-interactive Codex turn against the service and collect its tool calls. */
function codexTurn(prompt) {
  const args = [codexEntry, 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', workDir, '-s', 'read-only',
    '-c', "approval_policy='never'",
    '-c', `mcp_servers.acm.url='${service.mcpUrl}'`,
    '-c', "mcp_servers.acm.bearer_token_env_var='ACM_SESSION_TOKEN'",
    '-c', "mcp_servers.acm.default_tools_approval_mode='approve'",
    ...userServerNames().flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    prompt];
  const started = Date.now();
  const run = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: TURN_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, input: '',
    env: { ...process.env, ACM_SESSION_TOKEN: tokens.codex },
  });
  const events = (run.stdout ?? '').split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line));
  const items = events.filter((event) => event.type === 'item.completed').map((event) => event.item);
  return {
    exitCode: run.status,
    timedOut: run.error?.code === 'ETIMEDOUT',
    elapsedMs: Date.now() - started,
    threadId: events.find((event) => event.type === 'thread.started')?.thread_id ?? null,
    toolCalls: items.filter((item) => item.type === 'mcp_tool_call').map((item) => `${item.tool}:${item.status}`),
    lastMessage: items.filter((item) => item.type === 'agent_message').map((item) => item.text).at(-1) ?? '',
    stderrTail: (run.stderr ?? '').slice(-300),
  };
}

/** Repeat a re-entrant Codex turn until the service shows the step's outcome. */
async function codexStep(name, prompt, reached) {
  const attempts = [];
  let outcome;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const run = codexTurn(prompt);
    attempts.push(run);
    console.error(`[codex] ${name} attempt ${attempt}: exit=${run.exitCode} timedOut=${run.timedOut} ${Math.round(run.elapsedMs / 1000)}s calls=${run.toolCalls.join(',')}`);
    outcome = await reached(run);
    if (outcome) {
      break;
    }
  }
  const record = { step: name, attempts, reached: Boolean(outcome) };
  evidence.steps.push(record);
  return { attempts, last: attempts.at(-1), outcome, record };
}

const completedCalls = (attempts) => attempts.flatMap((run) => run.toolCalls).filter((call) => call.endsWith(':completed')).map((call) => call.split(':')[0]);
const conversationMessages = async () => (await service.admin('GET', `/api/v1/conversations/${ids.conversation}/messages?limit=200`)).messages;

describe('Codex real client, L1 shared read/write', { concurrency: false }, () => {
  before(async () => {
    const version = spawnSync(process.execPath, [codexEntry, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, `Codex CLI is not runnable at ${codexEntry}`);
    evidence.clientVersion = version.stdout.trim();
    const login = spawnSync(process.execPath, [codexEntry, 'login', 'status'], { encoding: 'utf8' });
    evidence.login = (login.stdout + login.stderr).trim();
    assert.match(evidence.login, /Logged in/i, 'Codex CLI must be logged in; run `codex login` first');

    ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    // This spec follows the operator approval flow, so default interconnection is switched off.
    await service.admin('PUT', '/api/v1/settings', { open_mode: false });
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_live', name: 'Live client check', root_path: workDir });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-cli', display_name: 'Codex' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_peer', provider: 'test', client_kind: 'mcp-sdk', display_name: 'SDK peer' });
    for (const [key, agent, label] of [['codex', 'agt_codex', 'codex real session'], ['peer', 'agt_peer', 'sdk peer']]) {
      const pairing = await service.admin('POST', '/api/v1/pairings', { agent_id: agent, project_id: 'prj_live', label });
      tokens[key] = pairing.token;
      ids[key] = pairing.session_id;
    }
    peer = await connectClient(service.mcpUrl, tokens.peer, 'sdk-peer');
    await callTool(peer, 'request_pairing', { client_kind: 'mcp-sdk' });
    await service.admin('POST', `/api/v1/pairings/${ids.peer}/approve`);
  });

  after(async () => {
    await peer?.close().catch(() => undefined);
    try {
      if (service !== undefined) {
        evidence.finalExitCode = service.child.exitCode === null ? await service.stop() : service.child.exitCode;
      }
    } finally {
      // Never leave the service running or the run unrecorded, whatever happened above.
      service?.child.kill();
      evidence.finishedAt = new Date().toISOString();
      const out = join(repoRoot, 'test-output', 'reports');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'codex-client.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('initializes, discovers tools and requests its own pairing', async () => {
    const session = async () => (await service.admin('GET', '/api/v1/sessions')).sessions.find((entry) => entry.session_id === ids.codex);
    const step = await codexStep('pairing',
      'You are checking an MCP server named acm. Do exactly this and nothing else: ' +
      '1) call the acm tool get_session; ' +
      `2) call the acm tool request_pairing with client_kind "codex-cli" and cwd "${workDir.replaceAll('\\', '\\\\')}"; ` +
      '3) reply with only the status value returned by step 2.',
      async () => (await session()).status === 'requested');
    const state = await session();
    step.record.sessionStatus = state.status;
    step.record.claimedClientKind = state.claimed_client_kind;
    assert.ok(step.outcome, 'the Codex session never reached pairing status "requested"');
    assert.equal(state.claimed_client_kind, 'codex-cli');
    assert.ok(completedCalls(step.attempts).includes('get_session'));
    assert.ok(completedCalls(step.attempts).includes('request_pairing'));

    await service.admin('POST', `/api/v1/pairings/${ids.codex}/approve`);
    const conversation = await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_live', task_code: 'LIVE-001', title: 'Codex live exchange' });
    ids.conversation = conversation.conversation_id;
    await service.admin('PUT', `/api/v1/conversations/${ids.conversation}/members`, { expected_version: 1, members: [{ session_id: ids.codex }, { session_id: ids.peer }] });
  });

  it('reads a directed message, acknowledges it and replies with the nonce it carried', async () => {
    assert.ok(ids.conversation, 'pairing step did not complete');
    const nonce = `NONCE-${randomBytes(6).toString('hex')}`;
    const sent = await callTool(peer, 'send_message', { conversation_id: ids.conversation, body: `Handoff check ${runId}. The verification word is ${nonce}.`, recipient_session_ids: [ids.codex], idempotency_key: `peer-1-${runId}` });
    ids.inbound = sent.result.message_id;

    const inspect = async () => {
      const messages = await conversationMessages();
      const inbound = messages.find((message) => message.message_id === ids.inbound);
      const replies = messages.filter((message) => message.sender.session_id === ids.codex);
      return { messages, inbound, replies };
    };
    // The nonce is not in the prompt: Codex can only learn it by reading the message.
    const step = await codexStep('read-ack-reply',
      'You are checking an MCP server named acm. Do exactly this and nothing else: ' +
      `1) call read_messages with conversation_id "${ids.conversation}" and after_seq 0; ` +
      '2) call acknowledge_message with the message_id of the message whose sequence is 1; ' +
      `3) call send_message with conversation_id "${ids.conversation}", reply_to_message_id set to that message_id, ` +
      `recipient_session_ids ["${ids.peer}"], idempotency_key "codex-reply-${runId}", and body "ACK <word>" where <word> is the verification word stated in that message; ` +
      '4) call send_message a second time with exactly the same arguments as step 3; ' +
      '5) reply with only the body you sent.',
      async () => {
        const state = await inspect();
        return state.inbound.recipients[0].status === 'acknowledged' && state.replies.length >= 1;
      });
    const { messages, inbound, replies } = await inspect();
    step.record.totalMessages = messages.length;
    step.record.inboundReceipt = inbound.recipients;
    step.record.replies = replies.map((message) => ({ message_id: message.message_id, sequence: message.sequence, body: message.body, reply_to: message.reply_to_message_id }));

    assert.ok(step.outcome, 'Codex did not acknowledge and reply');
    assert.equal(inbound.recipients[0].session_id, ids.codex);
    assert.equal(inbound.recipients[0].status, 'acknowledged');
    // However many times send_message ran with that key, exactly one reply is stored.
    const sends = completedCalls(step.attempts).filter((tool) => tool === 'send_message').length;
    step.record.completedSendCalls = sends;
    assert.ok(sends >= 2, 'the duplicate send was not exercised');
    assert.equal(messages.length, 2);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].body, `ACK ${nonce}`);
    assert.equal(replies[0].reply_to_message_id, ids.inbound);
    assert.equal(replies[0].sequence, 2);
    ids.reply = replies[0].message_id;

    // The peer receives the reply addressed to it and confirms it.
    const inbox = await callTool(peer, 'get_inbox');
    assert.equal(inbox.result.items.length, 1);
    assert.equal(inbox.result.items[0].body, `ACK ${nonce}`);
    assert.equal((await callTool(peer, 'acknowledge_message', { message_id: ids.reply })).result.status, 'acknowledged');
    ids.nonce = nonce;
  });

  it('reads the same history back after the service restarts', async () => {
    assert.ok(ids.nonce, 'exchange step did not complete');
    const before = await conversationMessages();
    await peer.close();
    assert.equal(await service.stop(), 0);
    service = await startService({ dataDir, ...ports });
    peer = await connectClient(service.mcpUrl, tokens.peer, 'sdk-peer-after-restart');
    assert.deepEqual(await conversationMessages(), before);

    const expected = [`1|Handoff check ${runId}. The verification word is ${ids.nonce}.`, `2|ACK ${ids.nonce}`];
    const lines = (run) => run.lastMessage.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const step = await codexStep('restart-readback',
      'You are checking an MCP server named acm. Do exactly this and nothing else: ' +
      `1) call read_messages with conversation_id "${ids.conversation}" and after_seq 0; ` +
      '2) reply with one line per message in the form "<sequence>|<body>", in order, and nothing else.',
      async (run) => JSON.stringify(lines(run)) === JSON.stringify(expected));
    step.record.messagesBefore = before.length;
    step.record.reported = lines(step.last);
    assert.ok(completedCalls(step.attempts).includes('read_messages'));
    assert.deepEqual(lines(step.last), expected);
  });
});
