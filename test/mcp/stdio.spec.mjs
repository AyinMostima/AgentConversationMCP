// Test for the stdio bridge (src/mcp/stdio.mjs): a client that launches the MCP
// server as a local command reaches the same store as HTTP clients, a missing
// credential is reported clearly, and the bridge starts the service by itself.
//
// Run: node --test test/mcp/stdio.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, connectClient, freePort, repoRoot, startService } from '../support/service.mjs';

const bridge = join(repoRoot, 'src', 'mcp', 'stdio.mjs');
const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-stdio-${runId}-`));
const dataDir = join(base, 'data');
let service;
let ports;
const tokens = {};
const sessions = {};
const open = [];

/** Launch the bridge the way a desktop client does: a command, arguments and an env block. */
async function connectStdio(extraArgs, env, launch) {
  const transport = new StdioClientTransport({
    command: launch?.command ?? process.execPath,
    args: [...(launch?.args ?? [bridge, '--data-dir', dataDir, '--mcp-port', String(ports.mcpPort), '--core-port', String(ports.corePort)]), ...extraArgs],
    env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', LOCALAPPDATA: process.env.LOCALAPPDATA ?? '', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-desktop-stand-in', version: '0.0.1' });
  await client.connect(transport);
  open.push(client);
  return client;
}

async function stopDetachedService() {
  const adminToken = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${ports.mcpPort}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken, connection: 'close' } });
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${ports.corePort}/healthz`);
      await new Promise((done) => setTimeout(done, 100));
    } catch {
      return true;
    }
  }
  return false;
}

describe('MCP stdio bridge', { concurrency: false }, () => {
  before(async () => {
    ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    await service.admin('POST', '/api/v1/projects', { project_id: 'prj_stdio', name: 'Stdio bridge' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_agy', provider: 'google', client_kind: 'antigravity', display_name: 'Antigravity' });
    await service.admin('POST', '/api/v1/agents', { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' });
    for (const [label, agent] of [['stdio', 'agt_agy'], ['http', 'agt_codex']]) {
      const pairing = await service.admin('POST', '/api/v1/pairings', { agent_id: agent, project_id: 'prj_stdio', label });
      tokens[label] = pairing.token;
      sessions[label] = pairing.session_id;
    }
  });

  after(async () => {
    for (const client of open) {
      await client.close().catch(() => undefined);
    }
    if (service?.child.exitCode === null) {
      await service.stop().catch(() => service.child.kill());
    }
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('exposes the same tools and reaches the same store as an HTTP client', async () => {
    const stdio = await connectStdio(['--no-autostart'], { ACM_SESSION_TOKEN: tokens.stdio });
    const names = (await stdio.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 22);
    assert.ok(names.includes('check_in') && names.includes('update_task') && names.includes('direct_message'));
    assert.ok(names.includes('send_message') && names.includes('get_inbox'));
    assert.equal(stdio.getServerVersion().name, 'agent-conversation-mcp');

    assert.equal((await callTool(stdio, 'get_session')).result.status, 'pending');
    // Default interconnection: reporting the instance is enough, no approval step.
    assert.equal((await callTool(stdio, 'request_pairing', { client_kind: 'antigravity', cwd: base })).result.status, 'active');

    const http = await connectClient(service.mcpUrl, tokens.http, 'http-peer');
    open.push(http);
    assert.equal((await callTool(http, 'request_pairing', { client_kind: 'codex-desktop' })).result.status, 'active');
    // Both transports land in the same lobby.
    const lobbies = [stdio, http].map(async (client) => (await callTool(client, 'list_conversations')).result.conversations);
    const [viaStdio, viaHttp] = await Promise.all(lobbies);
    assert.equal(viaStdio[0].kind, 'lobby');
    assert.equal(viaStdio[0].conversation_id, viaHttp[0].conversation_id);
    const conversation = await service.admin('POST', '/api/v1/conversations', { project_id: 'prj_stdio', task_code: 'STDIO-1', title: 'Bridge check' });
    await service.admin('PUT', `/api/v1/conversations/${conversation.conversation_id}/members`, { expected_version: 1, members: [{ session_id: sessions.stdio }, { session_id: sessions.http }] });

    // HTTP -> stdio
    const marker = `BRIDGE-${runId}`;
    const sent = await callTool(http, 'send_message', { conversation_id: conversation.conversation_id, body: `${marker} from http`, recipient_session_ids: [sessions.stdio], idempotency_key: `h-${runId}` });
    const inbox = await callTool(stdio, 'get_inbox');
    assert.equal(inbox.result.items.length, 1);
    assert.equal(inbox.result.items[0].body, `${marker} from http`);
    assert.equal((await callTool(stdio, 'acknowledge_message', { message_id: sent.result.message_id })).result.status, 'acknowledged');

    // stdio -> HTTP, with the author taken from the bridge's credential
    const reply = await callTool(stdio, 'send_message', { conversation_id: conversation.conversation_id, body: `${marker} from stdio`, reply_to_message_id: sent.result.message_id, idempotency_key: `s-${runId}` });
    assert.equal(reply.result.sender.session_id, sessions.stdio);
    assert.equal(reply.result.sequence, 2);
    const page = await callTool(http, 'read_messages', { conversation_id: conversation.conversation_id, after_seq: 1 });
    assert.deepEqual(page.result.messages.map((message) => message.body), [`${marker} from stdio`]);
    // Business errors pass through the bridge unchanged.
    assert.equal((await callTool(stdio, 'get_conversation', { conversation_id: 'cnv_missing' })).code, 'NOT_MEMBER');
  });

  it('hands out a launch command that reaches this instance, not the default one', async () => {
    // This service runs on a private data directory and private ports, like a second installation.
    const { service: info } = await service.admin('GET', '/api/v1/bootstrap');
    assert.deepEqual(info.stdio_args, [bridge, '--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)]);
    // A client launched with exactly what the service hands out lands on this store.
    const viaConfig = await connectStdio(['--no-autostart'], { ACM_SESSION_TOKEN: tokens.stdio }, { command: info.node_path, args: info.stdio_args });
    const session = await callTool(viaConfig, 'get_session');
    assert.equal(session.result.session_id, sessions.stdio);
    assert.equal(session.result.status, 'active');

    // The command line prints the same arguments for every desktop client.
    const cli = join(repoRoot, 'scripts', 'acm-admin.mjs');
    for (const client of ['claude', 'codex', 'antigravity', 'grok']) {
      const { stdout } = await promisify(execFile)(process.execPath, [cli, 'pair', '--client', client, '--project', 'prj_stdio', '--label', `cli ${client}`, '--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)]);
      const config = stdout.replaceAll('\\\\', '\\');
      for (const expected of ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)]) {
        assert.ok(config.includes(expected), `${client} configuration must carry ${expected}`);
      }
    }
  });

  it('needs no credential in the configuration: the bridge registers itself and stays the same session', async () => {
    // What an installed client launches: the entry and which application it is. No token anywhere.
    const first = await connectStdio(['--no-autostart', '--client', 'grok'], {});
    const session = (await callTool(first, 'get_session')).result;
    assert.equal(session.status, 'active');
    assert.equal(session.agent.display_name, 'Grok Bot');
    assert.equal(session.project_id, 'prj_default');
    assert.deepEqual(session.conversations.map((item) => item.kind), ['lobby']);
    // The identity is kept in the data directory, and only there.
    const identity = JSON.parse(readFileSync(join(dataDir, 'identities', 'grok.json'), 'utf8'));
    assert.match(identity.token, /^acm_[0-9a-f]{48}$/);
    assert.ok(!JSON.stringify(session).includes(identity.token));

    // Restarting the client keeps the session; another application is another session in the same lobby.
    const again = await connectStdio(['--no-autostart', '--client', 'grok'], {});
    assert.equal((await callTool(again, 'get_session')).result.session_id, session.session_id);
    const other = await connectStdio(['--no-autostart', '--client', 'claude'], {});
    const peer = (await callTool(other, 'get_session')).result;
    assert.notEqual(peer.session_id, session.session_id);
    assert.equal(peer.conversations[0].conversation_id, session.conversations[0].conversation_id);
    // They can talk at once, with nothing approved by anyone.
    const sent = await callTool(first, 'direct_message', { to_session_id: peer.session_id, body: `SELF-${runId}`, idempotency_key: `self-${runId}` });
    assert.equal(sent.result.sequence, 1);
    const seen = (await callTool(other, 'check_in')).result.conversations.find((item) => item.kind === 'direct');
    assert.deepEqual(seen.new_messages.map((message) => message.body), [`SELF-${runId}`]);

    // An operator-issued credential still wins, and an unknown one is refused instead of being registered.
    const wrong = await connectStdio(['--no-autostart', '--client', 'codex'], { ACM_SESSION_TOKEN: 'acm_not-a-real-token' });
    assert.equal((await callTool(wrong, 'get_session')).code, 'UNAUTHENTICATED');
    assert.ok(!existsSync(join(dataDir, 'identities', 'codex.json')), 'a configured credential must not create an identity file');
  });

  it('says how to start the service when it is down and autostart is off', async () => {
    assert.equal(await service.stop(), 0);
    const offline = await connectStdio(['--no-autostart'], { ACM_SESSION_TOKEN: tokens.stdio });
    const result = await callTool(offline, 'get_session');
    assert.equal(result.code, 'CORE_UNAVAILABLE');
    assert.match(result.error.message, /npm start/);
  });

  it('starts the service by itself and keeps the stored history', async () => {
    // The first client that needs the service starts it; here that client has no credential either.
    const starter = await connectStdio(['--client', 'grok'], {});
    const autostarted = await connectStdio([], { ACM_SESSION_TOKEN: tokens.stdio });
    try {
      assert.equal((await callTool(starter, 'get_session')).result.status, 'active');
      const session = await callTool(autostarted, 'get_session');
      assert.equal(session.result.status, 'active');
      assert.deepEqual(session.result.conversations.map((item) => item.task_code).sort(), ['@lobby', 'STDIO-1']);
      const bridged = session.result.conversations.find((item) => item.task_code === 'STDIO-1');
      const history = await callTool(autostarted, 'read_messages', { conversation_id: bridged.conversation_id });
      assert.equal(history.result.messages.length, 2);
      assert.ok(existsSync(join(dataDir, 'logs', 'service.log')), 'the background service writes a log file');
      // The bridge waits for the control service; the gateway line may follow a moment later.
      assert.match(readFileSync(join(dataDir, 'logs', 'service.log'), 'utf8'), /acm-core .* listening/);
    } finally {
      assert.equal(await stopDetachedService(), true, 'the autostarted service must stop cleanly');
    }
  });
});
