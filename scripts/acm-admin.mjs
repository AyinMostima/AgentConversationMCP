#!/usr/bin/env node
// Operator command line. A thin client of the operator REST API: everything it
// does is also available in the web console, and it holds no logic of its own.
//
//   node scripts/acm-admin.mjs console [--notify]           open the web console, signed in; starts the
//                                                           service in the background when it is not running
//                                                           (--notify reports a failure in a dialog, for the
//                                                           desktop shortcut that has no visible terminal)
//   node scripts/acm-admin.mjs status                       sessions and conversations
//   node scripts/acm-admin.mjs stop                         stop the running service
//   node scripts/acm-admin.mjs restart                      restart it; sessions and history are kept
//   node scripts/acm-admin.mjs init [--project NAME] [--project-id ID] [--root DIR]
//                                                           add the four desktop agents (and a project);
//                                                           with --project-id it is safe to repeat
//   node scripts/acm-admin.mjs pair --client claude|codex|antigravity|grok --project ID --label TEXT
//   node scripts/acm-admin.mjs pair --agent ID --project ID --label TEXT
//   node scripts/acm-admin.mjs approve <session_id>
//   node scripts/acm-admin.mjs open on|off              # default interconnection for the installation
//   node scripts/acm-admin.mjs link <session_id> on|off # one session in or out of it
//   node scripts/acm-admin.mjs revoke  <session_id>
//   node scripts/acm-admin.mjs get|post|put <path> [json | @file]
//
// Options: --data-dir DIR (default %USERPROFILE%\.acm), --core-port N (default 8766), --mcp-port N (default 8765).
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../src/mcp/paths.mjs';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const [, value] = argv.splice(index, 2);
  if (value === undefined) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolveDataDir(option('--data-dir'));
const corePort = option('--core-port', '8766');
const mcpPort = option('--mcp-port', '8765');
const coreUrl = `http://127.0.0.1:${corePort}`;
const mcpBase = `http://127.0.0.1:${mcpPort}`;
// Flags without a value.
const notify = argv.includes('--notify') && argv.splice(argv.indexOf('--notify'), 1).length === 1;
const flags = { client: option('--client'), agent: option('--agent'), project: option('--project'), label: option('--label'), root: option('--root'), projectId: option('--project-id') };
const [command, first, second] = argv;

const PRESETS = {
  claude: { agent_id: 'agt_claude', provider: 'anthropic', client_kind: 'claude-desktop', display_name: 'Claude' },
  codex: { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' },
  antigravity: { agent_id: 'agt_antigravity', provider: 'google', client_kind: 'antigravity', display_name: 'Antigravity' },
  grok: { agent_id: 'agt_grok', provider: 'xai', client_kind: 'grok-bot', display_name: 'Grok Bot' },
};

function adminToken() {
  const file = join(dataDir, 'admin-token.txt');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`[ERROR] no operator credential in ${dataDir}; the service has not been started on this data directory yet (npm start)`);
    } else {
      // The file is there but this shell may not read it, which is what a
      // sandboxed agent terminal runs into. Saying "not found" would mislead.
      console.error(`[ERROR] cannot read the operator credential ${file}: ${error.code ?? error.message}. This terminal is not allowed to read it; run the command from your own terminal.`);
    }
    process.exit(1);
  }
}

function readJson(text) {
  if (text === undefined) {
    return undefined;
  }
  return JSON.parse(text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text);
}

async function api(method, path, body, { tolerate } = {}) {
  let response;
  try {
    response = await fetch(`${coreUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error(`[ERROR] the service is not reachable at ${coreUrl}; start it with: npm start`);
    process.exit(1);
  }
  const envelope = await response.json();
  if (!envelope.ok) {
    if (tolerate === envelope.error.code) {
      return undefined;
    }
    console.error(`[ERROR] ${response.status} ${envelope.error.code}: ${envelope.error.message}`);
    if (Object.keys(envelope.error.details ?? {}).length > 0) {
      console.error(JSON.stringify(envelope.error.details, null, 2));
    }
    process.exit(1);
  }
  return envelope.result;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

/**
 * Ready-to-paste configuration for one desktop client. The arguments come from
 * the running service, so they name this instance's data directory and ports
 * instead of leaving the bridge to fall back to the default instance.
 */
function clientConfig(client, token, service) {
  const node = service.node_path ?? 'node';
  const args = service.stdio_args ?? [service.stdio_entry ?? '<project>\\src\\mcp\\stdio.mjs'];
  const json = JSON.stringify({ mcpServers: { acm: { command: node, args, env: { ACM_SESSION_TOKEN: token } } } }, null, 2);
  const shell = args.map((value) => (/\s/.test(value) ? `"${value}"` : value)).join(' ');
  switch (client) {
    case 'claude':
      return `Claude desktop (Code session) - put this in <project>\\.mcp.json, then open a new session in that folder:\n${json}`;
    case 'codex':
      return `Codex desktop - append to %USERPROFILE%\\.codex\\config.toml, then restart Codex:\n[mcp_servers.acm]\ncommand = '${node}'\nargs = [\n${args.map((value) => `  '${value}',`).join('\n')}\n]\n\n[mcp_servers.acm.env]\nACM_SESSION_TOKEN = "${token}"`;
    case 'antigravity':
      return `Antigravity - merge the acm entry into %USERPROFILE%\\.gemini\\config\\mcp_config.json, then refresh MCP servers:\n${json}`;
    case 'grok':
      return `Grok Bot - add a custom MCP server of the local command type:\n  name:    acm\n  command: ${node}\n  args:    ${shell}\n  env:     ACM_SESSION_TOKEN=${token}`;
    default:
      return `Any client that launches MCP servers as a command:\n${json}`;
  }
}
async function healthy() {
  try {
    return (await fetch(`${coreUrl}/healthz`)).ok;
  } catch {
    return false;
  }
}

/**
 * Start the service detached from this command when nothing answers yet,
 * logging to <data>/logs/service.log like the stdio bridge does. Returns false
 * when it did not come up.
 */
async function ensureService() {
  if (await healthy()) {
    return true;
  }
  const logFile = join(dataDir, 'logs', 'service.log');
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, 'a');
  spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'server.mjs'), '--data-dir', dataDir, '--mcp-port', mcpPort, '--core-port', corePort], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  }).unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await healthy()) {
      console.log(`[OK] started the service in the background (log: ${logFile})`);
      return true;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  console.error(`[ERROR] the service did not start; see ${logFile}`);
  if (notify) {
    // No terminal is visible when launched from the desktop shortcut, so report via a dialog.
    const text = `AGORA (AgentConversationMCP) failed to start. See log:\n${logFile}`;
    const script = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('${text.replaceAll("'", "''")}', 'AGORA - AgentConversationMCP')`;
    spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  return false;
}

switch (command) {
  case 'console': {
    if (!(await ensureService())) {
      process.exit(1);
    }
    await api('GET', '/api/v1/bootstrap');
    const url = `${coreUrl}/#token=${adminToken()}`;
    // The fragment is read by the page and never sent to a server.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log(`[OK] opening the operator console at ${coreUrl}/`);
    break;
  }
  case 'restart': {
    // The gateway starts its own replacement and stops; this waits until the replacement answers.
    let response;
    try {
      response = await fetch(`${mcpBase}/restart`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken() } });
    } catch {
      console.error(`[ERROR] no service is running at ${mcpBase}; start it with: npm start`);
      process.exit(1);
    }
    if (!response.ok) {
      console.error(`[ERROR] the service refused to restart (HTTP ${response.status}); check --data-dir`);
      process.exit(1);
    }
    let wentDown = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const up = await healthy();
      if (!up) {
        wentDown = true;
      } else if (wentDown) {
        console.log('[OK] service restarted');
        process.exit(0);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    console.error(`[ERROR] the service did not come back within 30 seconds; see ${join(dataDir, 'logs', 'service.log')}`);
    process.exit(1);
    break;
  }
  case 'stop': {
    // Asks the gateway to stop itself and the control service; both exit with code 0.
    let response;
    try {
      response = await fetch(`${mcpBase}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken() } });
    } catch {
      console.log(`[OK] no service is running at ${mcpBase}`);
      break;
    }
    if (!response.ok) {
      console.error(`[ERROR] the service refused to stop (HTTP ${response.status}); check --data-dir`);
      process.exit(1);
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await fetch(`${coreUrl}/healthz`);
        await new Promise((done) => setTimeout(done, 100));
      } catch {
        console.log('[OK] service stopped');
        process.exit(0);
      }
    }
    console.error('[ERROR] the service did not stop within 6 seconds');
    process.exit(1);
    break;
  }
  case 'status': {
    const state = await api('GET', '/api/v1/bootstrap');
    console.log(`[OK] core ${coreUrl} version=${state.service?.version ?? '?'} schema=${state.schema_version} events=${state.event_watermark}`);
    console.log(`  projects=${state.projects.length} agents=${state.agents.length}`);
    for (const session of state.sessions) {
      console.log(`  session ${session.session_id} ${session.status.padEnd(9)} agent=${session.agent_id} label="${session.label}" client=${session.claimed_client_kind ?? '-'}`);
    }
    for (const conversation of state.conversations) {
      console.log(`  conversation ${conversation.conversation_id} ${conversation.task_code} v${conversation.config_version} last_seq=${conversation.last_seq} members=${conversation.members.length}`);
    }
    break;
  }
  case 'init': {
    for (const preset of Object.values(PRESETS)) {
      const created = await api('POST', '/api/v1/agents', preset, { tolerate: 'ALREADY_EXISTS' });
      console.log(`[OK] agent ${preset.agent_id} ${created === undefined ? 'already exists' : 'created'}`);
    }
    if (flags.project !== undefined) {
      // With a fixed id the command can be repeated: an existing project is left as it is.
      const project = await api('POST', '/api/v1/projects', { project_id: flags.projectId, name: flags.project, root_path: flags.root }, { tolerate: flags.projectId === undefined ? undefined : 'ALREADY_EXISTS' });
      console.log(project === undefined ? `[OK] project ${flags.projectId} already exists` : `[OK] project "${project.name}" created: ${project.project_id}`);
    }
    break;
  }
  case 'pair': {
    const preset = flags.client === undefined ? undefined : PRESETS[flags.client];
    if (flags.client !== undefined && preset === undefined) {
      console.error('[ERROR] --client must be one of: claude, codex, antigravity, grok');
      process.exit(2);
    }
    const agentId = flags.agent ?? preset?.agent_id;
    if (agentId === undefined || flags.project === undefined || flags.label === undefined) {
      console.error('usage: acm-admin.mjs pair (--client NAME | --agent ID) --project ID --label TEXT');
      process.exit(2);
    }
    if (preset !== undefined) {
      await api('POST', '/api/v1/agents', preset, { tolerate: 'ALREADY_EXISTS' });
    }
    const created = await api('POST', '/api/v1/pairings', { agent_id: agentId, project_id: flags.project, label: flags.label });
    const { service, settings } = await api('GET', '/api/v1/bootstrap');
    console.log(`[OK] pairing created: session ${created.session_id}, complete it before ${created.pairing_expires_at}`);
    console.log('The credential below is shown once. Put it only into the client that should become this session.\n');
    console.log(`  token: ${created.token}\n`);
    console.log(clientConfig(flags.client, created.token, service));
    if (settings.open_mode) {
      console.log('\nNext: in that client ask it to call request_pairing and then check_in. Default interconnection is on, so no approval is needed and the session joins the project lobby.');
    } else {
      console.log(`\nNext: in that client ask it to call get_session and request_pairing, then approve it in the console or with:\n  node scripts/acm-admin.mjs approve ${created.session_id}`);
    }
    break;
  }
  case 'open':
  case 'link': {
    const value = command === 'open' ? first : second;
    if (value !== 'on' && value !== 'off') {
      console.error('usage: acm-admin.mjs open on|off | link <session_id> on|off');
      process.exit(2);
    }
    print(command === 'open'
      ? await api('PUT', '/api/v1/settings', { open_mode: value === 'on' })
      : await api('PUT', `/api/v1/sessions/${first}`, { linked: value === 'on' }));
    break;
  }
  case 'approve':
    print(await api('POST', `/api/v1/pairings/${first}/approve`));
    break;
  case 'revoke':
    print(await api('POST', `/api/v1/sessions/${first}/revoke`));
    break;
  case 'get':
    print(await api('GET', first));
    break;
  case 'post':
    print(await api('POST', first, readJson(second) ?? {}));
    break;
  case 'put':
    print(await api('PUT', first, readJson(second) ?? {}));
    break;
  default:
    console.error('usage: acm-admin.mjs console | status | init [--project NAME --root DIR] | pair --client NAME --project ID --label TEXT | restart | approve <session_id> | revoke <session_id> | open on|off | link <session_id> on|off | get|post|put <path> [json]');
    process.exit(2);
}
