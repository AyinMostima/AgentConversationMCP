// What every local entry point shares (the stdio MCP bridge and the command
// line): which instance to talk to, the identity of this application, starting
// the service when it is not running, and registering that identity.
//
// Nothing has to be prepared before a client can use an entry point:
//   - when the service is not running, the first caller starts it in the
//     background (unless --no-autostart is given);
//   - when no credential is configured, one is created, kept in the data
//     directory and registered with the service. With default interconnection
//     on, the session is usable at once.
// An operator-issued credential in ACM_SESSION_TOKEN takes precedence; such a
// caller never registers anything on its own.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, conversationOf, createCoreClient } from './mcp-server.mjs';
import { resolveDataDir } from './paths.mjs';
import { TOOLS, TOOL_CONTRACT } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN_SHAPE = /^acm_[0-9a-f]{48}$/;

/**
 * Takes the options every entry point understands out of `argv` (which is
 * modified) and returns them; what remains in `argv` belongs to the caller.
 *
 *   --client NAME  --label TEXT  --project ID  --identity-file PATH
 *   --data-dir DIR  --mcp-port N  --core-port N  --no-autostart
 */
export function takeBridgeOptions(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) {
      return false;
    }
    argv.splice(index, 1);
    return true;
  };
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index === -1) {
      return fallback;
    }
    const [, value] = argv.splice(index, 2);
    if (value === undefined) {
      throw new Error(`${name} needs a value`);
    }
    return value;
  };
  const autostart = !flag('--no-autostart');
  const dataDir = resolveDataDir(option('--data-dir'));
  const client = option('--client', 'mcp-client');
  if (!/^[a-z0-9-]{1,48}$/.test(client)) {
    throw new Error('--client must consist of lowercase letters, digits and dashes');
  }
  return {
    autostart,
    dataDir,
    client,
    mcpPort: option('--mcp-port', '8765'),
    corePort: option('--core-port', '8766'),
    label: option('--label'),
    project: option('--project'),
    identityFile: resolve(option('--identity-file', join(dataDir, 'identities', `${client}.json`))),
  };
}

/**
 * Starts the service (server.mjs with `args`) in the background, writing to `logFile`.
 *
 * A client that started an MCP server ends everything that server started when
 * it quits (Antigravity says so in its log: "Terminated N leftover processes of
 * MCP server"). A service started as a child of the bridge would end with the
 * client that happened to need it first, under every other client still using
 * it. On Windows it is therefore started by launch.mjs, which is created
 * through WMI: such a process is nobody's child and belongs to no client's job.
 * It gets the caller's environment. When that is not possible the service is
 * started as a detached child, as on other systems. ACM_LAUNCH=child forces
 * the latter.
 */
function launchService(args, logFile) {
  if (process.platform === 'win32' && process.env.ACM_LAUNCH !== 'child') {
    const words = [process.execPath, join(here, 'launch.mjs'), logFile, ...args].map((word) => `"${word}"`).join(' ');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      // The service gets the environment of this caller, minus what only this launch needs.
      "$environment = [string[]](Get-ChildItem Env: | Where-Object { $_.Name -notlike 'ACM_LAUNCH_*' } | ForEach-Object { $_.Name + '=' + $_.Value })",
      '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $environment }',
      '$made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:ACM_LAUNCH_COMMAND; CurrentDirectory = $env:ACM_LAUNCH_CWD; ProcessStartupInformation = $startup }',
      'if ($made.ReturnValue -ne 0) { exit 1 }',
    ].join('; ');
    const made = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ACM_LAUNCH_COMMAND: words, ACM_LAUNCH_CWD: resolve(here, '..', '..') },
      windowsHide: true,
      timeout: 20000,
      stdio: 'ignore',
    });
    if (made.status === 0) {
      return;
    }
  }
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [join(here, 'server.mjs'), ...args], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
}

/**
 * `say` receives one-line diagnostics; it must not write to stdout when stdout
 * carries a protocol or a result.
 */
export function createBridge(options, say) {
  const { autostart, dataDir, client, mcpPort, corePort, label, project, identityFile, relays = false } = options;
  const coreUrl = `http://${HOST}:${corePort}`;
  const mcpUrl = `http://${HOST}:${mcpPort}/mcp`;
  const callCore = createCoreClient(coreUrl);
  // Claude starts one bridge per conversation and names the conversation in its
  // environment. Only Claude's own bridge takes that for its conversation: any
  // other entry point started from inside a Claude conversation inherits the variable.
  const ownConversation = process.env.ACM_CLIENT_SESSION ?? (client === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : undefined);
  // What the client was last given: how many tools, of which contract version.
  let reported = { tools: TOOLS.length, contract: TOOL_CONTRACT };

  /**
   * The credential this application generated for itself, kept across restarts
   * so it stays the same session. When the file cannot be read or written the
   * credential lives for this process only, and that is said.
   */
  function ownCredential() {
    try {
      const stored = JSON.parse(readFileSync(identityFile, 'utf8')).token;
      if (TOKEN_SHAPE.test(stored)) {
        return stored;
      }
      say(`${identityFile} does not hold a valid credential; using a temporary identity for this run`);
      return `acm_${randomBytes(24).toString('hex')}`;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        say(`cannot read ${identityFile} (${error.code ?? error.message}); using a temporary identity for this run`);
        return `acm_${randomBytes(24).toString('hex')}`;
      }
    }
    const created = `acm_${randomBytes(24).toString('hex')}`;
    try {
      mkdirSync(dirname(identityFile), { recursive: true });
      // "wx" fails when another process of the same application wrote the file first.
      writeFileSync(identityFile, `${JSON.stringify({ client, token: created, created_at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
      return created;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return ownCredential();
      }
      say(`cannot write ${identityFile} (${error.code ?? error.message}); this identity lasts until the client restarts`);
      return created;
    }
  }

  const issued = (process.env.ACM_SESSION_TOKEN ?? '').trim();
  const selfIssued = issued === '';
  const token = selfIssued ? ownCredential() : issued;
  let enrolled = !selfIssued;

  async function answers(url) {
    try {
      return (await fetch(`${url}/healthz`)).ok;
    } catch {
      return false;
    }
  }
  const coreUp = () => answers(coreUrl);
  // A relay talks to the gateway, which says it is ready a moment after its control service does.
  const healthy = async () => (await coreUp()) && (!relays || (await answers(`http://${HOST}:${mcpPort}`)));

  /** Start the service detached from this caller, logging to <data>/logs/service.log. */
  async function ensureService() {
    if (await healthy()) {
      return;
    }
    if (await coreUp()) {
      // The service is starting: its gateway follows. Nothing to start, only to wait for.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((done) => setTimeout(done, 200));
        if (await healthy()) {
          return;
        }
      }
    }
    if (!autostart) {
      say(`the service is not running on ${coreUrl}; start it with "npm start"`);
      return;
    }
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    launchService(['--data-dir', dataDir, '--mcp-port', mcpPort, '--core-port', corePort], join(logDir, 'service.log'));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await healthy()) {
        say(`started the service in the background (log: ${join(logDir, 'service.log')})`);
        return;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    say(`the service did not start; see ${join(logDir, 'service.log')}`);
  }

  /** Register this application's own credential; resolves to a control-service envelope. */
  async function enroll() {
    let response;
    try {
      response = await fetch(`${coreUrl}/internal/v1/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        // bridge_tools and bridge_contract tell the console which tools this client has
        // been given; bridge_relay, that the bridge takes them from the service and so
        // follows it without being restarted.
        body: JSON.stringify({ client, label, project_id: project, cwd: process.cwd(), run_id: `pid-${process.pid}`, bridge_tools: reported.tools, bridge_contract: reported.contract, bridge_relay: relays }),
      });
    } catch (error) {
      return { status: 503, ok: false, error: { code: 'CORE_UNAVAILABLE', message: `the conversation service is not reachable at ${coreUrl}; start it with "npm start" (${error.message})`, details: {} } };
    }
    const envelope = { status: response.status, ...(await response.json()) };
    enrolled = envelope.ok;
    if (envelope.ok) {
      say(`session ${envelope.result.session_id} is ${envelope.result.status}`);
    }
    return envelope;
  }

  /** Make sure the service runs and this application is registered, once at startup. */
  async function start() {
    await ensureService();
    if (selfIssued) {
      const outcome = await enroll();
      if (!outcome.ok) {
        say(`not registered yet: ${outcome.error.code} ${outcome.error.message}`);
      }
    }
  }

  /** One agent command; resolves to a control-service envelope. */
  async function invoke(tool, args, meta) {
    const origin = { client, clientSession: conversationOf(meta, ownConversation) };
    if (!enrolled) {
      // Registration did not succeed at startup (service down, or revoked): try
      // again now, and report why when it still does not work.
      await ensureService();
      const outcome = await enroll();
      if (!outcome.ok) {
        return outcome;
      }
    }
    let answer = await callCore(token, tool, args, origin);
    if (!answer.ok && answer.error.code === 'CORE_UNAVAILABLE' && autostart) {
      // The service stopped since this caller started; whoever needs it next starts it.
      await ensureService();
      answer = await callCore(token, tool, args, origin);
    }
    if (!answer.ok && answer.error.code === 'UNAUTHENTICATED' && selfIssued) {
      // The store was replaced since this identity was registered: register it again, once.
      const outcome = await enroll();
      if (outcome.ok) {
        answer = await callCore(token, tool, args, origin);
      }
    }
    return answer;
  }

  let requestId = 0;

  /** One MCP request to the service's own endpoint. */
  async function post(method, params) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'x-acm-client': client };
    if (typeof ownConversation === 'string' && ownConversation !== '') {
      headers['x-acm-client-session'] = ownConversation.slice(0, 250);
    }
    let response;
    try {
      requestId += 1;
      response = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    } catch (error) {
      return { down: error.cause?.code ?? error.message };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, contract: Number(response.headers.get('x-acm-contract')) || undefined, body };
  }

  /**
   * Has the running service answer one MCP request (tools/list, tools/call,
   * initialize) and resolves to {result, contract}, to {refused: {code, message}}
   * when the service does not accept this session (a control-service error), to
   * {error: {code, message}} for a protocol error, or to {unavailable: text}
   * when it cannot be reached. The bridge holds no tool definitions of its own on this path: what
   * the service offers now is what the client gets.
   */
  async function relay(method, params) {
    if (!enrolled) {
      await ensureService();
      const outcome = await enroll();
      if (!outcome.ok) {
        return { unavailable: `${outcome.error.code}: ${outcome.error.message}` };
      }
    }
    let answer = await post(method, params);
    if ((answer.down !== undefined || answer.status === 503) && autostart) {
      // The service stopped or is still starting; whoever needs it next starts it.
      await ensureService();
      answer = await post(method, params);
    }
    if (answer.status === 401 && selfIssued) {
      // The store was replaced since this identity was registered: register it again, once.
      const outcome = await enroll();
      if (outcome.ok) {
        answer = await post(method, params);
      }
    }
    if (answer.down !== undefined) {
      return { unavailable: `the conversation service is not reachable at ${mcpUrl}; start it with "npm start" (${answer.down})` };
    }
    if (answer.body?.result !== undefined) {
      return { result: answer.body.result, contract: answer.contract };
    }
    if (answer.status === 503) {
      return { unavailable: answer.body?.error?.message ?? 'the conversation service is starting' };
    }
    if (answer.status === 401) {
      // Turned away at the door, as "CODE: message".
      const [, code, message] = /^([A-Z_]+): (.*)$/s.exec(answer.body?.error?.message ?? '') ?? [];
      return { refused: { code: code ?? 'UNAUTHENTICATED', message: message ?? 'the session credential is not accepted', details: {} } };
    }
    return { error: answer.body?.error ?? { code: -32603, message: `the service answered HTTP ${answer.status}` } };
  }

  /** Tells the service which tools the client now has, when that changed. */
  async function served(tools, contract) {
    if (!selfIssued || contract === undefined || (reported.tools === tools && reported.contract === contract)) {
      return;
    }
    reported = { tools, contract };
    await enroll();
  }

  return { client, coreUrl, start, invoke, relay, served };
}
