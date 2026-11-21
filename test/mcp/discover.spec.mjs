// Test for the discovery of conversations a client has on record
// (src/mcp/discover.mjs): a Codex thread that has done nothing since the
// service runs is a window that can be named and woken, and nothing else on
// that record becomes one. A made-up Codex home stands in for the real one.
//
// Run: node --test test/mcp/discover.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';
import { antigravityConversations, codexThreads } from '../../src/mcp/discover.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-discover-${runId}-`));
const dataDir = join(base, 'data');
const codexHome = join(base, 'codex-home');
const queuedFile = join(base, 'queued.jsonl');
const standIn = join(base, 'codex-stand-in.mjs');
writeFileSync(standIn, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(queuedFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);

/** One thread on Codex's record: a file whose first line describes it. */
function thread(id, meta, { ageHours = 1, day = '20' } = {}) {
  const directory = join(codexHome, 'sessions', '2026', '11', day);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `rollout-2026-11-${day}T10-00-00-${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ timestamp: '2026-11-20T10:00:00Z', type: 'session_meta', payload: { id, base_instructions: 'x'.repeat(200000), ...meta } })}\n${JSON.stringify({ type: 'turn', text: 'what was said stays unread' })}\n`);
  const when = new Date(Date.now() - ageHours * 3600 * 1000);
  utimesSync(file, when, when);
}
thread('aaaaaaaa-0000-7000-8000-000000000001', { originator: 'Codex Desktop', source: 'vscode', cwd: 'C:\\projects\\api' });
thread('aaaaaaaa-0000-7000-8000-000000000002', { originator: 'Codex Desktop', source: 'vscode', cwd: 'C:\\projects\\web' }, { ageHours: 3 });
// Not conversations of their own: a sub-agent, a command-line run, and one that was last used days ago.
thread('aaaaaaaa-0000-7000-8000-000000000003', { originator: 'Codex Desktop', source: { subagent: { depth: 1 } }, parent_thread_id: 'aaaaaaaa-0000-7000-8000-000000000001', cwd: 'C:\\projects\\api' });
thread('aaaaaaaa-0000-7000-8000-000000000004', { originator: 'codex_exec', source: 'exec', cwd: 'C:\\projects\\tmp' });
thread('aaaaaaaa-0000-7000-8000-000000000005', { originator: 'Codex Desktop', source: 'vscode', cwd: 'C:\\projects\\old' }, { ageHours: 72, day: '17' });
writeFileSync(
  join(codexHome, 'session_index.jsonl'),
  [
    { id: 'aaaaaaaa-0000-7000-8000-000000000001', thread_name: 'first title', updated_at: '2026-11-20T10:00:00Z' },
    { id: 'aaaaaaaa-0000-7000-8000-000000000001', thread_name: '推进 API 文档统一', updated_at: '2026-11-20T11:00:00Z' },
    { id: 'aaaaaaaa-0000-7000-8000-000000000005', thread_name: 'long ago', updated_at: '2026-11-17T10:00:00Z' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n'),
);

// Antigravity's own list of conversations, with one of its desktop app, a sub-agent of that one,
// one of its command line, and one from long ago.
const antigravityHome = join(base, 'antigravity-home');
mkdirSync(antigravityHome, { recursive: true });
const stamp = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '0000+00:00');
{
  const { DatabaseSync } = await import('node:sqlite');
  const list = new DatabaseSync(join(antigravityHome, 'conversation_summaries.db'));
  list.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT, source TEXT)');
  const add = list.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)');
  add.run('bbbbbbbb-0000-4000-8000-000000000001', 'WorkspaceV2 Cross-Project Synthesis and Audit', stamp(14), '["file:///c%3A/projects/workspace","file:///c%3A/projects/other"]', '', '');
  add.run('bbbbbbbb-0000-4000-8000-000000000002', 'helper of the audit', stamp(13), '[]', 'bbbbbbbb-0000-4000-8000-000000000001', '');
  add.run('bbbbbbbb-0000-4000-8000-000000000003', '', stamp(1), '["file:///c%3A/projects/workspace"]', '', 'CORTEX_TRAJECTORY_SOURCE_CLI');
  add.run('bbbbbbbb-0000-4000-8000-000000000004', 'long ago', stamp(90), '[]', '', '');
  list.close();
}
process.env.ACM_ANTIGRAVITY_HOME = antigravityHome;
process.env.ACM_DISCOVER = 'on';
process.env.ACM_DISCOVER_INTERVAL_MS = '300';
process.env.CODEX_HOME = codexHome;
process.env.ACM_DISPATCH_INTERVAL_MS = '250';
process.env.ACM_DISPATCH_COMMANDS = JSON.stringify({ codex: [process.execPath, standIn] });

let service;
let instance;
let lobby;
let codexSession;
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
async function cli(client, ...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args]);
  return JSON.parse(stdout).result;
}
const windowsOfCodex = async () => (await service.admin('GET', '/api/v1/bootstrap')).client_hooks.find((entry) => entry.session_id === codexSession)?.windows ?? [];

describe('conversations a client has on record', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reads which threads there are, and nothing of what was said in them', () => {
    const { windows: found, notWindows } = codexThreads({ env: { CODEX_HOME: codexHome } });
    // The sub-agent and the command-line run are named as what they are: no windows.
    assert.deepEqual(notWindows.map((id) => id.slice(-1)).sort(), ['3', '4']);
    assert.deepEqual(found.map((entry) => [entry.client_session.slice(-1), entry.title, entry.cwd]).sort(), [
      ['1', '推进 API 文档统一', 'C:\\projects\\api'],
      ['2', undefined, 'C:\\projects\\web'],
    ]);
    assert.ok(found.every((entry) => Date.parse(entry.seen_at) <= Date.now()));
    assert.ok(!JSON.stringify(found).includes('stays unread'));
    // No record at all is not an error.
    assert.deepEqual(codexThreads({ env: { CODEX_HOME: join(base, 'no-such-home') } }), { windows: [], notWindows: [] });
  });

  it('reads Antigravity\'s own list: desktop conversations with title and directory, nothing else', async () => {
    const { windows, notWindows } = await antigravityConversations({ env: { ACM_ANTIGRAVITY_HOME: antigravityHome } });
    assert.deepEqual(windows.map((entry) => [entry.client_session.slice(-1), entry.title, entry.cwd]), [['1', 'WorkspaceV2 Cross-Project Synthesis and Audit', 'c:\\projects\\workspace']]);
    assert.deepEqual(notWindows.map((id) => id.slice(-1)), ['2']);
    assert.deepEqual(await antigravityConversations({ env: { ACM_ANTIGRAVITY_HOME: join(base, 'no-such-home') } }), { windows: [], notWindows: [] });
  });

  it('makes them windows of the Codex session once there is one', async () => {
    // Nobody registered as Codex yet: nothing to attach the threads to.
    await sleep(1200);
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).client_hooks.length, 0);

    const who = await cli('codex', 'call', 'get_session');
    codexSession = who.session_id;
    lobby = who.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    await waitFor(async () => (await windowsOfCodex()).length === 2, 10000, 'the two threads to become windows');
    const windows = await windowsOfCodex();
    assert.deepEqual(windows.map((entry) => entry.name).filter((name) => !name.startsWith('codex-')), ['推进-API-文档统一']);
    assert.ok(windows.every((entry) => entry.imported && entry.state === 'idle'));
    // The title its client shows goes with the window: enough for another session to tell what it is.
    assert.equal(windows.find((entry) => entry.name === '推进-API-文档统一').title, '推进 API 文档统一');
    // The same for Antigravity, once it has a session.
    const gemini = (await cli('antigravity', 'call', 'get_session')).session_id;
    await waitFor(async () => ((await service.admin('GET', '/api/v1/bootstrap')).client_hooks.find((entry) => entry.session_id === gemini)?.windows ?? []).length === 1, 10000, 'the Antigravity conversation to become a window');
    const audit = (await service.admin('GET', '/api/v1/bootstrap')).client_hooks.find((entry) => entry.session_id === gemini).windows[0];
    assert.equal(audit.title, 'WorkspaceV2 Cross-Project Synthesis and Audit');
    assert.equal(audit.name, 'WorkspaceV2-Cross-Project-Synthesis-and');
    // A coordinating session sees all of it in check_in, and a wrong guess is answered with the choices.
    const roster = (await cli('claude', 'call', 'check_in')).project_sessions.flatMap((entry) => entry.windows ?? []);
    assert.ok(roster.some((entry) => entry.title === 'WorkspaceV2 Cross-Project Synthesis and Audit' && entry.cwd === 'c:\\projects\\workspace'));
    // Looking again does not add them twice.
    await sleep(1000);
    assert.equal((await windowsOfCodex()).length, 2);
  });

  it('wakes one by name, and none because a message went to everybody', async () => {
    await cli('claude', 'call', 'get_session');
    const send = (extra) => cli('claude', 'call', 'send_message', '--json', JSON.stringify({ conversation_id: lobby, urgent: true, idempotency_key: `k-${randomBytes(3).toString('hex')}`, ...extra }));
    await send({ body: 'everybody: report status' });
    await sleep(2500);
    assert.equal(existsSync(queuedFile), false, 'a message to everybody starts no thread from the record');

    await send({ body: 'api thread: resume the run', to_windows: ['推进-API-文档统一'] });
    await waitFor(() => existsSync(queuedFile), 15000, 'the named thread to be started');
    const started = readFileSync(queuedFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(started.map((entry) => entry[0]), ['aaaaaaaa-0000-7000-8000-000000000001']);
    assert.match(started[0][1], /api thread: resume the run/);
    assert.ok(!started[0][1].includes('everybody: report status'));
  });
});
