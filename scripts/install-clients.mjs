#!/usr/bin/env node
// Adds the "acm" MCP server to the user-level (global) configuration of the
// desktop clients, in each client's own folder under the home directory:
//
//   codex        %USERPROFILE%\.codex\config.toml
//   antigravity  %USERPROFILE%\.gemini\config\mcp_config.json
//   claude       %USERPROFILE%\.claude.json, written by Claude's own command line
//   grok         no known file; the values to enter in its settings are printed
//
// The entry carries no credential. The bridge it launches registers itself with
// the service and starts the service when it is not running, so nothing else
// has to be prepared: restart the client and the tools are there.
//
// It also installs the hooks that put messages from other sessions into the
// client's own conversation (src/mcp/hook.mjs), again in each client's folder:
//
//   claude       %USERPROFILE%\.claude\settings.json     SessionStart, UserPromptSubmit, Stop
//   codex        %USERPROFILE%\.codex\hooks.json         SessionStart, UserPromptSubmit, Stop
//   antigravity  %USERPROFILE%\.gemini\config\hooks.json  SessionStart, PreInvocation, Stop
//
// Codex runs a hook only after the person reviewed it once in the app
// (Settings, Hooks); that step is theirs and is not taken here.
//
//   node scripts/install-clients.mjs [claude] [codex] [antigravity] [grok]   default: all four
//   node scripts/install-clients.mjs --remove [clients...]
//
// Options: --home DIR (default: the user's home directory)
//          --data-dir DIR --core-port N --mcp-port N   for a non-default instance; passed on to the bridge
//          --no-hooks   only the MCP entry, no hooks
//          --hooks-only only the hooks, the MCP entry is left as it is
//
// Only the entry named acm and the hooks that run src/mcp/hook.mjs are added,
// replaced or removed. A file is backed up next to itself (.bak-acm-<time>)
// before its content changes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const [, value] = argv.splice(index, 2);
  if (value === undefined) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}
const customHome = option('--home');
const home = resolve(customHome ?? homedir());
const instance = [];
for (const name of ['--data-dir', '--core-port', '--mcp-port']) {
  const value = option(name);
  if (value !== undefined) {
    instance.push(name, name === '--data-dir' ? resolve(value) : value);
  }
}
const remove = argv.includes('--remove');
const withHooks = !argv.includes('--no-hooks');
const hooksOnly = argv.includes('--hooks-only');
const CLIENTS = ['claude', 'codex', 'antigravity', 'grok'];
const named = argv.filter((value) => !['--remove', '--no-hooks', '--hooks-only'].includes(value));
const unknown = named.filter((value) => !CLIENTS.includes(value));
if (unknown.length > 0) {
  console.error(`[ERROR] unknown client or option: ${unknown.join(', ')}. Clients: ${CLIENTS.join(', ')}`);
  process.exit(2);
}
const targets = named.length > 0 ? named : CLIENTS;

const node = process.execPath;
const bridgeArgs = (client) => [join(repoRoot, 'src', 'mcp', 'stdio.mjs'), '--client', client, ...instance];
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

// ---- hooks ---------------------------------------------------------------
const hookScript = join(repoRoot, 'src', 'mcp', 'hook.mjs');
const hookArgs = (client, event) => [hookScript, '--client', client, '--event', event, ...instance.filter((value, index, all) => value !== '--mcp-port' && all[index - 1] !== '--mcp-port')];
// How long a hook may take, in seconds. The watcher waits by design: it ends by
// itself a little before Claude would end it.
const HOOK_TIMEOUT = 10;
const WATCH_TIMEOUT = 3600;
const WATCH_SECONDS = 3400;

/** The 8.3 name of a path with blanks, when the volume has one; otherwise the path itself. */
function withoutBlanks(path) {
  if (!/\s/.test(path) || process.platform !== 'win32') {
    return path;
  }
  try {
    const short = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
    if (short !== '' && !/\s/.test(short) && existsSync(short)) {
      return short;
    }
  } catch {
    // No short name available: the quoted form below is used.
  }
  return path;
}

/**
 * One command line that cmd, PowerShell and Git Bash all run as written: no
 * blanks inside a word (so no quoting) and forward slashes (so nothing is taken
 * as an escape). Which of the three a client uses is not documented.
 */
function commandLine(client, event) {
  return [node, ...hookArgs(client, event)]
    .map((word) => withoutBlanks(word).replaceAll('\\', '/'))
    .map((word) => (/\s/.test(word) ? `"${word}"` : word))
    .join(' ');
}

const mentionsOurHook = (value) => JSON.stringify(value).replaceAll('\\\\', '/').includes('src/mcp/hook.mjs');

/** Reads a JSON settings file; an absent or empty one is {}. Invalid JSON throws and the file is left alone. */
function readJson(file) {
  const original = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
  return original.trim() === '' ? {} : JSON.parse(original);
}

/**
 * Claude's and Codex's shape: {hooks: {Event: [{matcher?, hooks: [handler]}]}}.
 * Takes our handlers out of every group, drops groups that end up empty, and
 * adds `ours` (event -> group) unless removing.
 */
function mergeEventHooks(config, ours) {
  const events = { ...(config.hooks ?? {}) };
  for (const event of Object.keys(events)) {
    if (!Array.isArray(events[event])) {
      continue;
    }
    events[event] = events[event]
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((handler) => !mentionsOurHook(handler)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (events[event].length === 0) {
      delete events[event];
    }
  }
  if (!remove) {
    for (const [event, group] of Object.entries(ours)) {
      events[event] = [...(events[event] ?? []), group];
    }
  }
  const merged = { ...config, hooks: events };
  if (Object.keys(events).length === 0) {
    delete merged.hooks;
  }
  return merged;
}

function claudeHooks() {
  const folder = join(home, '.claude');
  if (!existsSync(folder)) {
    return `hooks skipped, ${folder} does not exist`;
  }
  const file = join(folder, 'settings.json');
  // Claude starts the program itself (command plus args), so no shell reads the line.
  const run = (event, extra = {}) => ({ type: 'command', command: node, args: hookArgs('claude', event), timeout: HOOK_TIMEOUT, ...extra });
  // The watcher runs beside the conversation and wakes the model when something
  // urgent arrives. Both switches are needed: with asyncRewake alone Claude waits
  // for the hook to end before it goes on (seen with Claude Code 2.1.296).
  const watch = { ...run('watch', { async: true, asyncRewake: true, timeout: WATCH_TIMEOUT }), args: [...hookArgs('claude', 'watch'), '--max-seconds', String(WATCH_SECONDS)] };
  const merged = mergeEventHooks(readJson(file), {
    SessionStart: { hooks: [run('start'), watch] },
    UserPromptSubmit: { hooks: [run('prompt')] },
    Stop: { hooks: [run('stop'), watch] },
  });
  return `hooks: ${file} ${save(file, `${JSON.stringify(merged, null, 2)}\n`)}`;
}

function codexHooks() {
  const file = join(home, '.codex', 'hooks.json');
  const run = (event) => ({ type: 'command', command: commandLine('codex', event), timeout: HOOK_TIMEOUT });
  const merged = mergeEventHooks(readJson(file), {
    SessionStart: { matcher: 'startup|resume', hooks: [run('start')] },
    UserPromptSubmit: { hooks: [run('prompt')] },
    Stop: { hooks: [run('stop')] },
  });
  if (remove && !existsSync(file)) {
    return 'hooks: none installed';
  }
  return `hooks: ${file} ${save(file, `${JSON.stringify(merged, null, 2)}\n`)}${remove ? '' : '\n    Codex runs them after you reviewed them once: in the app, Settings > Hooks (or "Review hooks" in the composer)'}`;
}

function antigravityHooks() {
  const file = join(home, '.gemini', 'config', 'hooks.json');
  if (remove && !existsSync(file)) {
    return 'hooks: none installed';
  }
  const config = readJson(file);
  delete config.acm;
  if (!remove) {
    const run = (event) => [{ type: 'command', command: commandLine('antigravity', event), timeout: HOOK_TIMEOUT }];
    // PreInvocation runs before each call of the model, which covers the person's prompt.
    config.acm = { enabled: true, SessionStart: run('start'), PreInvocation: run('prompt'), Stop: run('stop') };
  }
  // No byte order mark: Antigravity ignored hook files that had one.
  return `hooks: ${file} ${save(file, `${JSON.stringify(config, null, 2)}\n`)}`;
}

/** Appends the outcome of the hooks step to that of the MCP step. */
function andHooks(outcome, step) {
  if (!withHooks && !remove) {
    return outcome;
  }
  return `${outcome}\n    ${step()}`;
}

/** Writes `text` to `file` when it differs, keeping the previous content in a backup. */
function save(file, text) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (before === text) {
    return 'unchanged';
  }
  if (before !== undefined) {
    copyFileSync(file, `${file}.bak-acm-${stamp}`);
  }
  writeFileSync(file, text);
  return before === undefined ? 'created' : `updated, backup ${file}.bak-acm-${stamp}`;
}

/** Drops the [mcp_servers.acm] table and its sub-tables from TOML text, leaving everything else as it is. */
function withoutAcmTables(lines) {
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header !== null) {
      const name = header[1].trim();
      skipping = name === 'mcp_servers.acm' || name.startsWith('mcp_servers.acm.');
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept;
}

function codex() {
  const folder = join(home, '.codex');
  if (!existsSync(folder)) {
    return `skipped, ${folder} does not exist (Codex has not been run on this account)`;
  }
  if (hooksOnly) {
    return codexHooks();
  }
  const file = join(folder, 'config.toml');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = withoutAcmTables(original.split(/\r?\n/));
  while (lines.length > 0 && lines.at(-1).trim() === '') {
    lines.pop();
  }
  if (!remove) {
    // Literal strings ('...') keep Windows backslashes as they are.
    lines.push(...(lines.length > 0 ? [''] : []), '[mcp_servers.acm]', `command = '${node}'`, 'args = [', ...bridgeArgs('codex').map((value) => `  '${value}',`), ']');
  }
  return andHooks(`${file} ${save(file, `${lines.join(eol)}${eol}`)}`, codexHooks);
}

function antigravity() {
  const folder = join(home, '.gemini', 'config');
  if (!existsSync(folder)) {
    return `skipped, ${folder} does not exist (Antigravity has not been run on this account)`;
  }
  if (hooksOnly) {
    return antigravityHooks();
  }
  const file = join(folder, 'mcp_config.json');
  const original = existsSync(file) ? readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
  // A file that is not valid JSON is left alone: JSON.parse throws and the run reports it.
  const config = original.trim() === '' ? {} : JSON.parse(original);
  config.mcpServers ??= {};
  if (remove) {
    delete config.mcpServers.acm;
  } else {
    config.mcpServers.acm = { command: node, args: bridgeArgs('antigravity') };
  }
  return andHooks(`${file} ${save(file, `${JSON.stringify(config, null, 2)}\n`)}`, antigravityHooks);
}

function claude() {
  if (hooksOnly) {
    return claudeHooks();
  }
  // Claude keeps user-level servers in a file it rewrites itself, so its own
  // command line makes the change. The npm shim points at this executable.
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(home, '.local', 'bin', 'claude.exe'),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (cli === undefined) {
    const hooks = withHooks || remove ? `\n    ${claudeHooks()}` : '';
    return `skipped, Claude's command line was not found; add it by hand with:\n    claude mcp add acm --scope user -- "${node}" ${bridgeArgs('claude').join(' ')}${hooks}`;
  }
  const run = (args) => execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: customHome === undefined ? process.env : { ...process.env, USERPROFILE: home, HOME: home } });
  const listed = run(['mcp', 'list']);
  if (/^acm:/m.test(listed)) {
    run(['mcp', 'remove', 'acm', '--scope', 'user']);
  }
  if (remove) {
    return andHooks(`${join(home, '.claude.json')} entry removed`, claudeHooks);
  }
  run(['mcp', 'add', 'acm', '--scope', 'user', '--', node, ...bridgeArgs('claude')]);
  return andHooks(`${join(home, '.claude.json')} updated through "claude mcp add --scope user"`, claudeHooks);
}

function grok() {
  if (hooksOnly) {
    return 'skipped, Grok Bot has no hooks; it is told through its webhook routine (console: wake hook)';
  }
  if (remove) {
    return 'remove the server named acm in Grok Bot: Settings, custom MCP servers';
  }
  return [
    'no configuration file is known for Grok Bot; add a custom MCP server of the local command type in its settings:',
    '    name:      acm',
    `    command:   ${node}`,
    ...bridgeArgs('grok').map((value, index) => `    ${index === 0 ? 'arguments:' : '          '} ${value}`),
    '    (no environment variables are needed)',
  ].join('\n');
}

const steps = { claude, codex, antigravity, grok };
let failed = false;
for (const client of targets) {
  try {
    const outcome = steps[client]();
    console.log(`${outcome.startsWith('skipped') ? '[SKIP]' : '[OK]'} ${client}: ${outcome}`);
  } catch (error) {
    failed = true;
    const detail = String(error.stderr ?? '').trim() || error.message;
    console.error(`[ERROR] ${client}: ${detail}`);
  }
}
if (!remove && !failed && !hooksOnly) {
  console.log('\nRestart each client completely. No pairing step is needed: the first one to start also starts the service.');
}
if (!remove && !failed && hooksOnly) {
  console.log('\nHooks are picked up by conversations started from now on. Codex asks you to review them once (Settings > Hooks).');
}
process.exit(failed ? 1 : 0);
