// Test for the idle dispatcher (src/mcp/dispatch.mjs): the routes of a client
// are tried in order, a command that runs a whole turn counts as handed over
// once it is under way, and a stand-in acts for a conversation that cannot be
// started itself. Stand-in programs take the place of the vendors' command
// lines; no real client is started.
//
// Run: node --test test/mcp/dispatch.spec.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';
import { dispatchRoutes } from '../../src/mcp/dispatch.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-dispatch-${runId}-`));
const dataDir = join(base, 'data');
const refusedFile = join(base, 'refused.jsonl');
const turnsFile = join(base, 'turns.jsonl');
const refusing = join(base, 'queue-stand-in.mjs');
const turning = join(base, 'turn-stand-in.mjs');
const queuedFile = join(base, 'queued.jsonl');
const openedFile = join(base, 'opened.jsonl');
const noting = join(base, 'note-stand-in.mjs');
// Stands in for "codex queue" when nothing answers it.
writeFileSync(refusing, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(refusedFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.error('app-server is not running');\nprocess.exit(2);\n`);
// Stands in for a command that runs a whole turn: says which conversation it used, works for a while, ends.
writeFileSync(
  turning,
  [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(turnsFile)}, JSON.stringify({ args: process.argv.slice(2), hooks: process.env.ACM_HOOKS ?? null }) + '\\n');`,
    "console.log(JSON.stringify({ conversation_id: '0f0f0f0f-aaaa-bbbb-cccc-121212121212', status: 'SUCCESS' }));",
    'setTimeout(() => process.exit(0), 2500);',
  ].join('\n'),
);
// Stands in for a command that only hands something on: notes what it was given in the file named first.
writeFileSync(noting, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify([...process.argv.slice(3), Date.now()]) + '\\n');\n");
process.env.ACM_DISPATCH_INTERVAL_MS = '250';
process.env.ACM_DISPATCH_GRACE_MS = '600';
process.env.ACM_DISPATCH_COMMANDS = JSON.stringify({
  codex: [[process.execPath, refusing], { command: [process.execPath, turning], long: true }],
  antigravity: [{ command: [process.execPath, turning], long: true, standIn: true }],
  helper: [
    { command: [process.execPath, noting, queuedFile], step: 0, patience: 5 },
    { command: [process.execPath, noting, openedFile], step: [1, 2], patience: 5, spacing: 2500 },
  ],
});

let service;
let instance;
let lobby;
const sessions = {};
let key = 0;
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
function hook(client, event, input) {
  return new Promise((done, fail) => {
    const args = instance.filter((value, index, all) => value !== '--mcp-port' && all[index - 1] !== '--mcp-port');
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'hook.mjs'), '--client', client, '--event', event, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.once('error', fail);
    child.once('exit', () => done(stdout));
    child.stdin.end(JSON.stringify(input));
  });
}
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const hooksOf = async (client) => (await service.admin('GET', '/api/v1/bootstrap')).client_hooks.find((entry) => entry.session_id === sessions[client]);

describe('idle dispatch through the clients\' command lines', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    for (const client of ['claude', 'codex', 'antigravity']) {
      const who = await cli(client, 'call', 'get_session');
      sessions[client] = who.session_id;
      lobby = who.conversations.find((entry) => entry.kind === 'lobby').conversation_id;
    }
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('offers the vendors\' commands in order, and a stand-in where a conversation cannot be opened', () => {
    // A machine with both command lines installed, and one Antigravity command-line conversation on record.
    const home = join(base, 'home');
    mkdirSync(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    mkdirSync(join(home, 'AppData', 'Local', 'agy', 'bin'), { recursive: true });
    writeFileSync(join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), '');
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'conversations', 'aaaaaaaa-1111-2222-3333-444444444444.db'), '');
    const routes = dispatchRoutes({ USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });

    const job = { window_id: 'win_1', window: 'iso', client_session: 'thread-1', text: 'do it' };
    // Codex: into the thread's queue, then the desktop app is asked to open the thread. No command-line turn.
    assert.deepEqual(routes.codex.map((route) => [route.name, route.step, route.long]), [['codex queue', 0, false], ['open in Codex desktop', [1, 2], false]]);
    assert.ok(routes.codex[1].spacingMs >= 5000, 'the app is not asked for two threads in the same instant');
    assert.deepEqual(routes.codex[0].command(job).args.slice(1), ['queue', '--thread', 'thread-1', '--message', 'do it']);
    const uuid = { ...job, client_session: '01a1f740-8164-7423-bad4-18972bd6686f' };
    assert.equal(routes.codex[1].command(uuid).args.at(-1), "Start-Process 'codex://threads/01a1f740-8164-7423-bad4-18972bd6686f'");
    // Nothing that is not a plain id ends up in a link.
    assert.equal(routes.codex[1].command({ ...job, client_session: 'x" & calc' }), undefined);
    // Running the turn from the command line is something the operator switches on.
    const withCli = dispatchRoutes({ USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), ACM_CODEX_CLI: 'on' });
    assert.deepEqual(withCli.codex.map((route) => route.name), ['codex queue', 'open in Codex desktop', 'codex exec resume']);
    assert.equal(withCli.codex[2].command({ ...job, attempt: 2 }), undefined);
    assert.deepEqual(withCli.codex[2].command({ ...job, attempt: 3 }).args.slice(1), ['exec', 'resume', '--skip-git-repo-check', 'thread-1', 'do it']);

    const [own, standIn] = routes.antigravity;
    // A desktop conversation is not on the command line's record: only the stand-in applies.
    const desktop = { ...job, client_session: 'bbbbbbbb-1111-2222-3333-444444444444' };
    assert.equal(own.command(desktop, {}), undefined);
    const first = standIn.command(desktop, {});
    assert.ok(!first.args.includes('--conversation'), 'the first wake starts a new command-line conversation');
    assert.match(first.args.at(-1), /^\[ACM\] You were started from the command line as a stand-in for the Antigravity desktop conversation "iso"/);
    assert.ok(first.args.at(-1).endsWith('do it'));
    assert.deepEqual(first.env, { ACM_HOOKS: 'off' });
    // Nobody confirms its tool calls: it is given a settings file that allows the acm tools, for that run only.
    assert.ok(!first.args.includes('--settings'));
    const allowed = standIn.command(desktop, {}, 'C:\data\stand-in-settings.json');
    assert.deepEqual(allowed.args.slice(0, 2), ['--settings', 'C:\data\stand-in-settings.json']);
    // Later wakes continue the conversation that stood in before.
    const later = standIn.command(desktop, { win_1: 'aaaaaaaa-1111-2222-3333-444444444444' });
    assert.deepEqual(later.args.slice(0, 2), ['--conversation', 'aaaaaaaa-1111-2222-3333-444444444444']);
    // A window that is a command-line conversation is resumed as itself, with nothing added.
    const cliWindow = own.command({ ...job, client_session: 'aaaaaaaa-1111-2222-3333-444444444444' }, {});
    assert.deepEqual(cliWindow.args.slice(0, 2), ['--conversation', 'aaaaaaaa-1111-2222-3333-444444444444']);
    assert.equal(cliWindow.args.at(-1), 'do it');
    // None of it without the command lines, and none in a test run.
    assert.deepEqual(dispatchRoutes({ USERPROFILE: join(base, 'nobody'), APPDATA: join(base, 'nobody'), LOCALAPPDATA: join(base, 'nobody') }), {});
    assert.deepEqual(dispatchRoutes({ USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), ACM_DISPATCH_BUILTIN: 'off' }), {});
  });

  it('falls back to the next command, and wakes Antigravity through a stand-in when its window is named', async () => {
    await hook('codex', 'stop', { session_id: 'thread-a', cwd: base });
    await hook('antigravity', 'stop', { conversationId: 'agy-desktop-1', workspacePaths: [base] });
    const send = (extra) => cli('claude', 'call', 'send_message', '--json', JSON.stringify({ conversation_id: lobby, urgent: true, idempotency_key: `k${++key}`, ...extra }));
    // To everybody: nobody is started.
    await send({ body: 'everybody: start the nightly build' });
    await sleep(7000);
    assert.equal(lines(turnsFile).length, 0);
    assert.equal(lines(refusedFile).length, 0);

    // For Codex as such: its thread is idle, and is started through its command line.
    await send({ body: 'codex: start the nightly build', recipient_session_ids: [sessions.codex] });
    await waitFor(() => lines(turnsFile).length === 1, 20000, 'the Codex turn to be started');
    const forCodex = lines(turnsFile)[0];
    assert.equal(forCodex.args[0], 'thread-a');
    assert.match(forCodex.args[1], /codex: start the nightly build/);
    // The queue refused first, then the turn was run from the command line.
    assert.deepEqual(lines(refusedFile).map((entry) => entry[0]), ['thread-a']);
    // Neither of them put a stand-in to work for the Antigravity window; a message that names it does.
    const desktop = (await hooksOf('antigravity')).windows[0].name;
    await send({ body: 'antigravity: redraw figure 3', to_windows: [desktop] });
    await waitFor(() => lines(turnsFile).length === 2, 20000, 'the stand-in to be started');
    const forAntigravity = lines(turnsFile)[1];
    assert.equal(forAntigravity.args[0], 'agy-desktop-1');
    assert.match(forAntigravity.args[1], /antigravity: redraw figure 3/);
    assert.ok(!forAntigravity.args[1].includes('start the nightly build'));

    await waitFor(async () => (await hooksOf('codex')).last_urgent?.status === 'ok' && (await hooksOf('antigravity')).last_urgent?.status === 'ok', 10000, 'both to be reported as handed over');
    assert.match((await hooksOf('codex')).last_urgent.detail, /turn-stand-in\.mjs: started; the turn is running/);
    // The conversation that stood in is remembered for the next wake of that window.
    await waitFor(() => existsSync(join(dataDir, 'stand-ins.json')), 10000, 'the stand-in to be remembered');
    assert.deepEqual(Object.values(JSON.parse(readFileSync(join(dataDir, 'stand-ins.json'), 'utf8'))), ['0f0f0f0f-aaaa-bbbb-cccc-121212121212']);
    // What a stand-in is allowed without anyone confirming: the acm tools, nothing else.
    const allowed = JSON.parse(readFileSync(join(dataDir, 'stand-in-settings.json'), 'utf8')).permissions.allow;
    assert.ok(allowed.includes('mcp(acm/check_in)') && allowed.includes('mcp(acm/send_message)'));
    assert.ok(allowed.every((rule) => /^mcp\(acm\/[a-z_]+\)$/.test(rule)));

    // The Codex thread itself received the message: its next prompt does not repeat it.
    assert.equal(await hook('codex', 'prompt', { session_id: 'thread-a' }), '');
    // The Antigravity desktop conversation did not (a stand-in did the work): its next prompt shows it.
    const shown = JSON.parse(await hook('antigravity', 'prompt', { conversationId: 'agy-desktop-1' }));
    assert.match(JSON.stringify(shown), /antigravity: redraw figure 3/);
  });

  it('asks the application to open a conversation that did not start on what was queued for it', async () => {
    // A window of another client, with the two steps Codex has: hand the message over, then have the app open it.
    const helper = (await cli('helper', 'call', 'get_session')).session_id;
    // Its client reports through the same entry the hook program uses.
    const token = JSON.parse(readFileSync(join(dataDir, 'identities', 'helper.json'), 'utf8')).token;
    const report = async (event, conversation = 'helper-thread-1') => {
      const response = await fetch(`http://127.0.0.1:${instance[3]}/internal/v1/hook`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ event, client: 'helper', client_session: conversation }) });
      assert.equal(response.status, 200);
      return (await response.json()).result.window.name;
    };
    // Two idle conversations of it, both named by one message.
    const names = [await report('stop'), await report('stop', 'helper-thread-2')];
    await cli('claude', 'call', 'send_message', '--json', JSON.stringify({ conversation_id: lobby, body: 'helpers: resume', urgent: true, to_windows: names, idempotency_key: `k${++key}` }));
    await waitFor(() => lines(queuedFile).length === 2, 20000, 'the message to be queued for both');
    assert.match(lines(queuedFile)[0][1], /helpers: resume/);
    assert.equal(lines(openedFile).length, 0, 'opening is not tried before the queue had its chance');
    // Nothing is heard from either within the time the first step allows: the application is asked
    // to open them, one after the other and not in the same instant.
    await waitFor(() => lines(openedFile).length === 2, 25000, 'the application to be asked to open both conversations');
    const opened = lines(openedFile);
    assert.deepEqual(opened.map((entry) => entry[0]).sort(), ['helper-thread-1', 'helper-thread-2']);
    assert.ok(Math.abs(opened[1].at(-1) - opened[0].at(-1)) >= 2000, 'the two requests are kept apart');
    assert.equal(lines(queuedFile).length, 2, 'the message is not queued a second time');
    // One of them acts: nothing more for it. The other is asked for once more, then given up.
    await report('prompt');
    await report('stop');
    await waitFor(() => lines(openedFile).length === 3, 25000, 'the silent conversation to be asked for a second time');
    assert.equal(lines(openedFile)[2][0], 'helper-thread-2');
    await sleep(9000);
    assert.equal(lines(openedFile).length, 3, 'and not a third time');
  });
});
