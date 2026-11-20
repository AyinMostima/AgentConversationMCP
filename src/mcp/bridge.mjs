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
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, createCoreClient } from './mcp-server.mjs';
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
 * `say` receives one-line diagnostics; it must not write to stdout when stdout
 * carries a protocol or a result.
 */
export function createBridge(options, say) {
  const { autostart, dataDir, client, mcpPort, corePort, label, project, identityFile } = options;
  const coreUrl = `http://${HOST}:${corePort}`;
  const callCore = createCoreClient(coreUrl);

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

  async function healthy() {
    try {
      return (await fetch(`${coreUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  /** Start the service detached from this caller, logging to <data>/logs/service.log. */
  async function ensureService() {
    if (await healthy()) {
      return;
    }
    if (!autostart) {
      say(`the service is not running on ${coreUrl}; start it with "npm start"`);
      return;
    }
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const log = openSync(join(logDir, 'service.log'), 'a');
    const child = spawn(process.execPath, [join(here, 'server.mjs'), '--data-dir', dataDir, '--mcp-port', mcpPort, '--core-port', corePort], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
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
        // bridge_tools and bridge_contract let the console tell a client that still runs an older bridge from a current one.
        body: JSON.stringify({ client, label, project_id: project, cwd: process.cwd(), run_id: `pid-${process.pid}`, bridge_tools: TOOLS.length, bridge_contract: TOOL_CONTRACT }),
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
  async function invoke(tool, args) {
    if (!enrolled) {
      // Registration did not succeed at startup (service down, or revoked): try
      // again now, and report why when it still does not work.
      await ensureService();
      const outcome = await enroll();
      if (!outcome.ok) {
        return outcome;
      }
    }
    let answer = await callCore(token, tool, args);
    if (!answer.ok && answer.error.code === 'CORE_UNAVAILABLE' && autostart) {
      // The service stopped since this caller started; whoever needs it next starts it.
      await ensureService();
      answer = await callCore(token, tool, args);
    }
    if (!answer.ok && answer.error.code === 'UNAUTHENTICATED' && selfIssued) {
      // The store was replaced since this identity was registered: register it again, once.
      const outcome = await enroll();
      if (outcome.ok) {
        answer = await callCore(token, tool, args);
      }
    }
    return answer;
  }

  return { client, coreUrl, start, invoke };
}
