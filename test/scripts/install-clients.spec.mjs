// Test for scripts/install-clients.mjs: the global configuration of each
// desktop client gets exactly one "acm" entry without a credential, everything
// else in those files is preserved, and a client launched from the installed
// entry reaches the service and is usable with no further step.
//
// Run: node --test test/scripts/install-clients.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, freePort, repoRoot, startService } from '../support/service.mjs';

const installer = join(repoRoot, 'scripts', 'install-clients.mjs');
const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-install-${runId}-`));
const home = join(base, 'home');
const dataDir = join(base, 'data');
const codexFile = join(home, '.codex', 'config.toml');
const agyFile = join(home, '.gemini', 'config', 'mcp_config.json');
let service;
let ports;
const open = [];

// What a user already has: other servers, comments, and an old acm entry with a credential.
const codexBefore = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.other]',
  "command = 'other.exe'",
  '',
  '[mcp_servers.acm]',
  "command = 'old-node.exe'",
  "args = ['old-entry.mjs']",
  '',
  '[mcp_servers.acm.env]',
  'ACM_SESSION_TOKEN = "acm_old"',
  '',
  '[mcp_servers.after]  # keep me',
  "command = 'after.exe'",
  '',
].join('\r\n');
const agyBefore = { mcpServers: { 'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp'] } }, other: true };

async function install(...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [installer, ...args, '--home', home, '--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)]);
  return stdout;
}
const backups = (folder) => readdirSync(folder).filter((name) => name.includes('.bak-acm-'));

describe('client installer', { concurrency: false }, () => {
  before(async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(codexFile, codexBefore);
    writeFileSync(agyFile, JSON.stringify(agyBefore, null, 2));
    ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
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

  it('adds one acm entry without a credential and keeps everything else', async () => {
    const output = await install('codex', 'antigravity', 'grok');
    assert.match(output, /\[OK\] codex: /);
    assert.match(output, /\[OK\] antigravity: /);
    assert.match(output, /\[OK\] grok: [\s\S]*--client[\s\S]*grok/);

    const codex = readFileSync(codexFile, 'utf8');
    assert.equal(codex.match(/^\[mcp_servers\.acm\]/gm).length, 1);
    assert.ok(!codex.includes('acm.env') && !codex.includes('acm_old') && !codex.includes('old-entry'), 'the old entry and its credential are gone');
    for (const kept of ['model = "gpt-5"', '[mcp_servers.other]', "command = 'other.exe'", '[mcp_servers.after]  # keep me', "command = 'after.exe'"]) {
      assert.ok(codex.includes(kept), `codex configuration must keep: ${kept}`);
    }
    assert.ok(codex.includes("'--client',\r\n  'codex',"), 'the bridge is told which application it is');
    assert.ok(!codex.replaceAll('\r\n', '').includes('\n'), 'line endings of the file are kept');
    assert.ok(!/ACM_SESSION_TOKEN|acm_[0-9a-f]{48}/.test(codex));

    const agy = JSON.parse(readFileSync(agyFile, 'utf8'));
    assert.deepEqual(agy.mcpServers['chrome-devtools'], agyBefore.mcpServers['chrome-devtools']);
    assert.equal(agy.other, true);
    assert.equal(agy.mcpServers.acm.command, process.execPath);
    assert.deepEqual(agy.mcpServers.acm.args.slice(0, 3), [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', 'antigravity']);
    assert.equal(agy.mcpServers.acm.env, undefined);

    // The previous content is kept next to each file.
    assert.equal(readFileSync(join(home, '.codex', backups(join(home, '.codex'))[0]), 'utf8'), codexBefore);
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'config', backups(join(home, '.gemini', 'config'))[0]), 'utf8')), agyBefore);
  });

  it('changes nothing when it is run again', async () => {
    const codex = readFileSync(codexFile, 'utf8');
    const agy = readFileSync(agyFile, 'utf8');
    const output = await install('codex', 'antigravity');
    assert.match(output, /codex: .* unchanged/);
    assert.match(output, /antigravity: .* unchanged/);
    assert.equal(readFileSync(codexFile, 'utf8'), codex);
    assert.equal(readFileSync(agyFile, 'utf8'), agy);
    assert.equal(backups(join(home, '.codex')).length, 1);
  });

  it('a client launched from the installed entry is usable at once', async () => {
    const entry = JSON.parse(readFileSync(agyFile, 'utf8')).mcpServers.acm;
    const client = new Client({ name: 'installed-client', version: '0.0.1' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: [...entry.args, '--no-autostart'], env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' }, stderr: 'pipe' }));
    open.push(client);
    const session = (await callTool(client, 'check_in')).result;
    assert.equal(session.label, 'antigravity');
    assert.deepEqual(session.conversations.map((item) => item.kind), ['lobby']);
    const listed = (await service.admin('GET', '/api/v1/sessions')).sessions;
    assert.deepEqual(listed.map((item) => [item.agent_id, item.status]), [['agt_antigravity', 'active']]);
  });

  it('skips a client that is not installed and removes only its own entry', async () => {
    const empty = join(base, 'empty-home');
    mkdirSync(empty);
    const { stdout } = await promisify(execFile)(process.execPath, [installer, 'codex', 'antigravity', '--home', empty]);
    assert.match(stdout, /\[SKIP\] codex: /);
    assert.match(stdout, /\[SKIP\] antigravity: /);
    assert.deepEqual(readdirSync(empty), []);

    await install('--remove', 'codex', 'antigravity');
    const codex = readFileSync(codexFile, 'utf8');
    assert.ok(!codex.includes('mcp_servers.acm'));
    assert.ok(codex.includes('[mcp_servers.other]') && codex.includes('[mcp_servers.after]  # keep me'));
    assert.deepEqual(JSON.parse(readFileSync(agyFile, 'utf8')), agyBefore);
    await assert.rejects(promisify(execFile)(process.execPath, [installer, 'notepad', '--home', home]), /unknown client/);
  });

  it("installs each client's hooks next to the hooks that are already there", async () => {
    const claudeFile = join(home, '.claude', 'settings.json');
    const codexHooks = join(home, '.codex', 'hooks.json');
    const agyHooks = join(home, '.gemini', 'config', 'hooks.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const other = { hooks: [{ type: 'command', command: 'other-tool.exe --check' }] };
    writeFileSync(claudeFile, JSON.stringify({ idleCompaction: true, hooks: { Stop: [other], PreToolUse: [{ matcher: 'Bash', hooks: other.hooks }] } }, null, 2));
    writeFileSync(codexHooks, JSON.stringify({ hooks: { UserPromptSubmit: [other] } }, null, 2));
    // A byte order mark and another product's hook: both are common in the wild.
    writeFileSync(agyHooks, `\uFEFF${JSON.stringify({ 'my-linter-hook': { PostToolUse: [{ matcher: 'run_command', hooks: other.hooks }] } }, null, 2)}`);

    const output = await install('--hooks-only', 'claude', 'codex', 'antigravity', 'grok');
    assert.match(output, /\[OK\] claude: hooks: /);
    assert.match(output, /\[OK\] codex: hooks: [\s\S]*reviewed them once/);
    assert.match(output, /\[OK\] antigravity: hooks: /);
    assert.match(output, /\[SKIP\] grok: /);
    const script = join(repoRoot, 'src', 'mcp', 'hook.mjs');

    // Claude: the program and its arguments separately, so no shell reads the line.
    const claude = JSON.parse(readFileSync(claudeFile, 'utf8'));
    assert.equal(claude.idleCompaction, true);
    assert.deepEqual(claude.hooks.PreToolUse, [{ matcher: 'Bash', hooks: other.hooks }]);
    assert.deepEqual(claude.hooks.Stop[0], other);
    assert.deepEqual(Object.keys(claude.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const prompt = claude.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(prompt.command, process.execPath);
    assert.deepEqual(prompt.args.slice(0, 5), [script, '--client', 'claude', '--event', 'prompt']);
    assert.ok(prompt.args.includes(String(ports.corePort)) && !prompt.args.includes('--mcp-port'));
    // The watcher must be a background hook, or Claude would wait for it.
    assert.deepEqual(claude.hooks.Stop[1].hooks.map((entry) => [entry.args[4], entry.async === true && entry.asyncRewake === true]), [['stop', false], ['watch', true]]);
    const watcher = claude.hooks.Stop[1].hooks[1];
    assert.ok(Number(watcher.args[watcher.args.indexOf('--max-seconds') + 1]) < watcher.timeout, 'the watcher ends by itself before its time limit');
    assert.deepEqual(claude.hooks.SessionStart[0].hooks.map((entry) => entry.args[4]), ['start', 'watch']);

    // Codex and Antigravity: one line that every Windows shell runs as written.
    const codex = JSON.parse(readFileSync(codexHooks, 'utf8'));
    assert.deepEqual(codex.hooks.UserPromptSubmit[0], other);
    const line = codex.hooks.Stop[0].hooks[0].command;
    assert.ok(!/[\\"']/.test(line), `no backslash and no quote in: ${line}`);
    assert.match(line, / --client codex --event stop /);
    assert.equal(codex.hooks.SessionStart[0].matcher, 'startup|resume');
    // After every tool call: what is urgent reaches a turn that is under way. It has to be quick.
    assert.match(codex.hooks.PostToolUse[0].hooks[0].command, / --client codex --event tool /);
    assert.equal(codex.hooks.PostToolUse[0].hooks[0].timeout, 5);
    const agy = JSON.parse(readFileSync(agyHooks, 'utf8'));
    assert.ok(!readFileSync(agyHooks, 'utf8').startsWith('\uFEFF'), 'written without a byte order mark');
    assert.deepEqual(Object.keys(agy), ['my-linter-hook', 'acm']);
    assert.equal(agy.acm.enabled, true);
    assert.deepEqual(Object.keys(agy.acm), ['enabled', 'SessionStart', 'PreInvocation', 'Stop']);
    assert.match(agy.acm.PreInvocation[0].command, / --client antigravity --event prompt /);

    // The installed lines really run: through cmd, PowerShell and directly, each ends with exit code 0.
    const shells = [[process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', line]], ['powershell.exe', ['-NoProfile', '-Command', line]]];
    for (const [shell, args] of shells) {
      const { stdout } = await promisify(execFile)(shell, args);
      assert.equal(stdout.trim(), '', `${shell} ran the hook and it had nothing to add`);
    }
    assert.equal((await promisify(execFile)(agy.acm.Stop[0].command.split(' ')[0], agy.acm.Stop[0].command.split(' ').slice(1))).stdout, '{}');
    assert.equal((await promisify(execFile)(prompt.command, prompt.args)).stdout, '');

    // Again: nothing changes. Removing: only our hooks go.
    assert.match(await install('--hooks-only', 'claude', 'codex', 'antigravity'), /claude: .* unchanged[\s\S]*codex: .* unchanged[\s\S]*antigravity: .* unchanged/);
    await install('--hooks-only', '--remove', 'claude', 'codex', 'antigravity');
    assert.deepEqual(JSON.parse(readFileSync(claudeFile, 'utf8')), { idleCompaction: true, hooks: { Stop: [other], PreToolUse: [{ matcher: 'Bash', hooks: other.hooks }] } });
    assert.deepEqual(JSON.parse(readFileSync(codexHooks, 'utf8')), { hooks: { UserPromptSubmit: [other] } });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(agyHooks, 'utf8'))), ['my-linter-hook']);
  });
});
