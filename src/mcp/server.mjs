#!/usr/bin/env node
// acm-mcp: the normal service entry. Starts the C++ control service (acm-core)
// as a child process and exposes it to agents as one MCP Streamable HTTP
// endpoint built on the official MCP SDK. This process holds no state and
// makes no rule decisions: it forwards the caller's credential and arguments
// to the control service and relays the answer. The control service also
// serves the operator console and its API on its own port.
//
//   node src/mcp/server.mjs [--data-dir DIR] [--mcp-port 8765] [--core-port 8766] [--core-exe PATH] [--ui-dir DIR]
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HOST, VERSION, buildMcpServer, conversationOf, createCoreClient } from './mcp-server.mjs';
import { TOOL_CONTRACT } from './tools.mjs';
import { resolveDataDir } from './paths.mjs';
import { ngrokComponent, startRemoteAccess } from './remote.mjs';
import { startAlerts } from './alerts.mjs';
import { startDiscovery } from './discover.mjs';
import { startDispatcher } from './dispatch.mjs';
import { startWakeDispatcher } from './wake.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseOptions(argv) {
  const options = {
    dataDir: undefined,
    mcpPort: 8765,
    corePort: 8766,
    coreExe: process.env.ACM_CORE_EXE ?? join(repoRoot, 'build', 'windows-dev', 'RelWithDebInfo', 'acm-core.exe'),
    // A console built elsewhere (for example to try it beside the running service) is served with ACM_UI_DIR.
    uiDir: process.env.ACM_UI_DIR ?? join(repoRoot, 'ui', 'dist'),
  };
  const names = { '--data-dir': 'dataDir', '--mcp-port': 'mcpPort', '--core-port': 'corePort', '--core-exe': 'coreExe', '--ui-dir': 'uiDir' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(`unknown or incomplete option ${argv[index]}`);
    }
    options[key] = key.endsWith('Port') ? Number.parseInt(value, 10) : resolve(value);
  }
  // Without --data-dir the installation's own folder in the home directory is used.
  options.dataDir ??= resolveDataDir();
  for (const key of ['mcpPort', 'corePort']) {
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 65535) {
      throw new Error(`${key} must be a TCP port number`);
    }
  }
  return options;
}

// --takeover: this process replaces a running one (see restart below) and
// first waits for it to release the ports.
const launchArgs = process.argv.slice(2).filter((value) => value !== '--takeover');
const takeover = launchArgs.length !== process.argv.length - 2;
const options = parseOptions(launchArgs);
const coreUrl = `http://${HOST}:${options.corePort}`;
const callCore = createCoreClient(coreUrl);
const consoleBuilt = existsSync(join(options.uiDir, 'index.html'));

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function rpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

async function handleMcp(request, response) {
  if (request.method !== 'POST') {
    // Stateless mode: no server-initiated stream and no session to delete.
    sendJson(response, 405, rpcError(-32000, 'Method not allowed; this endpoint accepts POST only'), { allow: 'POST' });
    return;
  }
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (token === '') {
    sendJson(response, 401, rpcError(-32001, 'A session credential is required: Authorization: Bearer <token>'), {
      'www-authenticate': 'Bearer realm="agent-conversation-mcp"',
    });
    return;
  }
  // A stdio bridge that relays here says which application it serves and, when its
  // client told it, which conversation; both only label the caller's own windows.
  const said = (name) => {
    const value = request.headers[name];
    return typeof value === 'string' && value !== '' ? value.slice(0, 250) : undefined;
  };
  const client = /^[a-z0-9-]{1,32}$/.test(said('x-acm-client') ?? '') ? said('x-acm-client') : undefined;
  const hint = said('x-acm-client-session');
  const origin = (meta) => ({ client, clientSession: conversationOf(meta, hint) });
  // Reject unknown and revoked credentials at the door, before any MCP exchange.
  const session = await callCore(token, 'get_session', {}, origin(undefined));
  if (!session.ok && (session.status === 401 || session.status === 503)) {
    sendJson(response, session.status, rpcError(-32001, `${session.error.code}: ${session.error.message}`));
    return;
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, rpcError(-32700, 'Parse error'));
    return;
  }
  // A fresh MCP server per request keeps the endpoint stateless; the credential is the only context.
  const server = buildMcpServer((tool, args, meta) => callCore(token, tool, args, origin(meta)));
  // Lets a relaying bridge notice that the tools changed since its client last listed them.
  response.setHeader('x-acm-contract', String(TOOL_CONTRACT));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

// ---- lifecycle -------------------------------------------------------------

if (!existsSync(options.coreExe)) {
  console.error(`[ERROR] control service binary not found: ${options.coreExe}. Build it with: cmake --build --preset windows-dev`);
  process.exit(1);
}
mkdirSync(options.dataDir, { recursive: true });

if (takeover) {
  // Both ports must be quiet before the control service and this gateway can bind them.
  const quiet = async (url) => {
    try {
      await fetch(url);
      return false;
    } catch {
      return true;
    }
  };
  let released = false;
  for (let attempt = 0; attempt < 150 && !released; attempt += 1) {
    released = (await quiet(`${coreUrl}/healthz`)) && (await quiet(`http://${HOST}:${options.mcpPort}/healthz`));
    if (!released) {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (!released) {
    console.error('[ERROR] the previous service did not stop within 15 seconds; not starting a second one');
    process.exit(1);
  }
}

let stopping = false;
let stopWake = () => undefined;
let stopDispatch = () => undefined;
let stopDiscovery = () => undefined;
let stopAlerts = () => undefined;
let stopRemote = async () => undefined;
const coreArgs = [
  '--data-dir', options.dataDir, '--host', HOST, '--port', String(options.corePort),
  // Shown by the console in ready-to-paste client configuration.
  '--mcp-url', `http://${HOST}:${options.mcpPort}/mcp`,
  '--mcp-port', String(options.mcpPort),
  '--stdio-entry', join(repoRoot, 'src', 'mcp', 'stdio.mjs'),
  '--node-path', process.execPath,
];
if (consoleBuilt) {
  coreArgs.push('--ui-dir', options.uiDir);
}
// Several clients may start the service in the same instant. The gateway port
// decides which start is the one: it is bound before anything else happens, and
// a start that finds it taken ends quietly without touching the running
// service. Only then is the control service started. `ready` turns true once it
// answers; until then the gateway says so instead of serving.
let core;
let ready = false;
function startCore() {
  core = spawn(options.coreExe, coreArgs, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  core.on('exit', (code) => {
    if (!stopping) {
      console.error(`[ERROR] control service exited unexpectedly with code ${code}; is port ${options.corePort} already in use?`);
      process.exit(1);
    }
  });
}

async function waitForCore() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${coreUrl}/healthz`);
      if (response.ok) {
        return (await response.json()).result;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`control service did not become healthy on ${coreUrl}`);
}

const adminToken = () => readFileSync(join(options.dataDir, 'admin-token.txt'), 'utf8').trim();

const http = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${HOST}`).pathname;
  const fail = (error) => {
    console.error(`[ERROR] ${request.method} ${path}: ${error.stack ?? error}`);
    if (!response.headersSent) {
      sendJson(response, 500, rpcError(-32603, 'Internal error'));
    }
  };
  if (!ready) {
    sendJson(response, 503, { ok: false, error: { code: 'STARTING', message: 'the service is starting', details: {} } });
  } else if (path === '/mcp') {
    handleMcp(request, response).catch(fail);
  } else if (path === '/healthz' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, result: { status: 'ok', version: VERSION, core: coreUrl } });
  } else if (path === '/restart' && request.method === 'OPTIONS') {
    // The console is served by the control service on another port, so its
    // restart button reaches this endpoint across origins. Only that origin is let in.
    response.writeHead(204, restartCors);
    response.end();
  } else if (path === '/restart' && request.method === 'POST') {
    // The installation's credential, or a login of the operator's account (the control service knows those).
    const presented = request.headers['x-acm-admin-token'];
    const known = presented === adminToken()
      ? Promise.resolve(true)
      : typeof presented === 'string' && presented.startsWith('acmlogin_')
        ? fetch(`${coreUrl}/api/v1/session`, { headers: { 'x-acm-admin-token': presented } }).then((answer) => answer.ok, () => false)
        : Promise.resolve(false);
    void known.then((yes) => {
      if (!yes) {
        sendJson(response, 401, { ok: false, error: { code: 'ADMIN_REQUIRED', message: 'sign in first' } }, restartCors);
        return;
      }
      sendJson(response, 200, { ok: true, result: { restarting: true } }, restartCors);
      restart().catch(fail);
    });
  } else if (path === '/shutdown' && request.method === 'POST') {
    if (request.headers['x-acm-admin-token'] !== adminToken()) {
      sendJson(response, 401, { ok: false, error: { code: 'ADMIN_REQUIRED', message: 'operator credential required' } });
      return;
    }
    sendJson(response, 200, { ok: true, result: { stopping: true } });
    stop(0).catch(fail);
  } else {
    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  }
});

const restartCors = {
  'access-control-allow-origin': coreUrl,
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'x-acm-admin-token, content-type',
  vary: 'origin',
};

/**
 * Start a replacement with the same arguments, then stop. The replacement
 * waits for this process to release the ports; the store is untouched, so
 * sessions, conversations and history are the same afterwards.
 */
async function restart() {
  const logDir = join(options.dataDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, 'service.log'), 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), ...launchArgs, '--takeover'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  console.log('[OK] acm-mcp restarting');
  await stop(0);
}

/** Stop accepting requests, ask the control service to stop, then exit. */
async function stop(exitCode) {
  if (stopping) {
    return;
  }
  stopping = true;
  stopWake();
  // Before the control service goes: turns started from here are reported as cut short.
  await stopDispatch();
  stopDiscovery();
  stopAlerts();
  await stopRemote();
  http.close();
  http.closeAllConnections();
  if (core === undefined) {
    // Stopped before the control service was started: there is nothing else to end.
    process.exit(exitCode);
  }
  const exited = new Promise((done) => core.once('exit', done));
  try {
    await fetch(`${coreUrl}/internal/v1/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken() } });
  } catch {
    core.kill();
  }
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
  if (core.exitCode === null) {
    core.kill();
  }
  console.log('[OK] acm-mcp stopped');
  process.exit(exitCode);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  await new Promise((bound, refused) => {
    http.once('error', refused);
    http.listen(options.mcpPort, HOST, bound);
  }).catch((error) => {
    if (error.code === 'EADDRINUSE') {
      // Someone else was first. That is the service; this start has nothing to do.
      console.log(`[OK] a service already runs on ${HOST}:${options.mcpPort}; this start is not needed`);
      process.exit(0);
    }
    console.error(`[ERROR] cannot listen on ${HOST}:${options.mcpPort}: ${error.message}`);
    process.exit(1);
  });
  http.on('error', (error) => console.error(`[ERROR] gateway: ${error.message}`));
  startCore();
  const health = await waitForCore();
  ready = true;
  console.log(`[OK] acm-mcp ${VERSION} listening on http://${HOST}:${options.mcpPort}/mcp (core ${coreUrl}, schema ${health.schema_version}, data ${options.dataDir})`);
  console.log(consoleBuilt
    ? `[OK] operator console: ${coreUrl}/  (open it signed in with: npm run console)`
    : '[WARN] operator console is not built; run: npm run build:ui');
  // Outgoing wake signals for sessions that have to be told from outside that work waits.
  stopWake = startWakeDispatcher({
    coreUrl,
    adminToken,
    intervalMs: Number(process.env.ACM_WAKE_INTERVAL_MS ?? 5000),
    say: (line) => console.log(`[OK] ${line}`),
  });
  // Urgent messages for sessions whose client is idle: handed to that client's own command.
  stopDispatch = startDispatcher({
    coreUrl,
    adminToken,
    dataDir: options.dataDir,
    intervalMs: Number(process.env.ACM_DISPATCH_INTERVAL_MS ?? 5000),
    graceMs: Number(process.env.ACM_DISPATCH_GRACE_MS ?? 10000),
    say: (line) => console.log(`[OK] ${line}`),
  });
  // Conversations a client has on record become windows without having to act first.
  // ACM_DISCOVER=off is for tests, which must not read this machine's own record.
  if (process.env.ACM_DISCOVER !== 'off') {
    stopDiscovery = startDiscovery({
      coreUrl,
      adminToken,
      intervalMs: Number(process.env.ACM_DISCOVER_INTERVAL_MS ?? 60000),
      say: (line) => console.log(`[OK] ${line}`),
    });
  }
  // A system notification when a route stopped working. ACM_ALERTS=off is for tests.
  if (process.env.ACM_ALERTS !== 'off') {
    stopAlerts = startAlerts({
      coreUrl,
      adminToken,
      dataDir: options.dataDir,
      intervalMs: Number(process.env.ACM_ALERT_INTERVAL_MS ?? 30000),
      say: (line) => console.log(`[WARN] ${line}`),
    });
  }
  // Remote access to the console through a tunnel, when the operator has switched it on.
  // ACM_TUNNEL_STUB=1 is for tests: "installing" writes a marker file and the
  // "tunnel" is the local proxy itself, so nothing is downloaded and no network is used.
  const stubMarker = join(options.dataDir, 'components', 'stub-installed');
  const stubComponent = {
    installed: () => existsSync(stubMarker),
    install: async () => {
      await new Promise((done) => setTimeout(done, 300));
      mkdirSync(join(options.dataDir, 'components'), { recursive: true });
      writeFileSync(stubMarker, 'stub\n');
    },
    // ACM_TUNNEL_STUB_REFUSE: a pattern of domains this stand-in refuses, as ngrok refuses a
    // name to an account that may not choose one. Every domain asked for is written down.
    openTunnel: async ({ port, domain }) => {
      appendFileSync(join(options.dataDir, 'components', 'stub-domains.log'), `${domain}\n`);
      const refuse = process.env.ACM_TUNNEL_STUB_REFUSE;
      if (refuse !== undefined && refuse !== '' && domain !== '' && new RegExp(refuse).test(domain)) {
        throw new Error(`ERR_NGROK_STUB this account may not bind ${domain}`);
      }
      return { url: `http://${HOST}:${port}`, close: async () => undefined };
    },
  };
  stopRemote = startRemoteAccess({
    coreUrl,
    adminToken,
    component: process.env.ACM_TUNNEL_STUB === '1' ? stubComponent : ngrokComponent(options.dataDir),
    onRestart: () => void restart().catch((error) => console.error(`[ERROR] restart: ${error.stack ?? error}`)),
    intervalMs: Number(process.env.ACM_REMOTE_INTERVAL_MS ?? 3000),
    say: (line) => console.log(`[OK] ${line}`),
  });
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  await stop(1);
}
