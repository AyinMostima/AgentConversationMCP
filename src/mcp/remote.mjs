// Remote access to the operator console through an ngrok tunnel. Entirely
// optional: the ngrok component is not installed, and nothing is opened, until
// the operator installs it, enters an ngrok authtoken and switches it on.
//
// The tunnel does not point at the control service. It points at a small proxy
// started here, which forwards the console and its operator API and nothing
// else:
//   - /internal/... (agent commands, self-enrollment, shutdown) is not
//     reachable from outside; those entry points stay local to this machine;
//   - the two endpoints that hand credentials to this gateway are not
//     forwarded either;
//   - every operator call still needs the operator credential, and an address
//     that keeps presenting a wrong one is locked out for a while.
// Restarting the service from a remote console goes through this proxy too,
// because the page cannot reach the gateway port of this machine from outside.
//
// The control service holds the settings and shows the state; this module
// follows them: it opens the tunnel when they say so, closes it when they
// change, and reports what happened.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The official ngrok SDK, pinned to the version this was checked against.
const NGROK_PACKAGE = '@ngrok/ngrok@1.8.0';

const NOT_FORWARDED = ['/api/v1/remote-access/config', '/api/v1/remote-access/report', '/api/v1/wake/claim', '/api/v1/wake/report', '/api/v1/delivery/claim', '/api/v1/delivery/report'];
const MAX_FAILURES = 20;
const LOCKOUT_MS = 10 * 60 * 1000;

function deny(response, status, code, message) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: { code, message, details: {} } }));
}

/**
 * The proxy the tunnel points at. `onRestart()` restarts the service; the
 * returned server is already listening on a free loopback port.
 */
export async function startConsoleProxy({ coreUrl, adminToken, onRestart }) {
  const core = new URL(coreUrl);
  // Wrong credentials per caller address, to stop guessing.
  const failures = new Map();
  const callerOf = (request) => String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
  const lockedOut = (caller) => {
    const entry = failures.get(caller);
    if (entry === undefined || entry.until === undefined) {
      return false;
    }
    if (entry.until < Date.now()) {
      failures.delete(caller);
      return false;
    }
    return true;
  };
  const countFailure = (caller) => {
    const entry = failures.get(caller) ?? { count: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.until = Date.now() + LOCKOUT_MS;
    }
    failures.set(caller, entry);
  };

  // The installation's credential, or a login of the operator's account (which the control service knows).
  const allowed = async (presented) => {
    if (typeof presented !== 'string' || presented === '') {
      return false;
    }
    if (presented === adminToken()) {
      return true;
    }
    if (!presented.startsWith('acmlogin_')) {
      return false;
    }
    try {
      return (await fetch(`${coreUrl}/api/v1/session`, { headers: { 'x-acm-admin-token': presented } })).ok;
    } catch {
      return false;
    }
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', coreUrl).pathname;
    const caller = callerOf(request);
    if (lockedOut(caller)) {
      deny(response, 429, 'RATE_LIMITED', 'too many requests with a wrong operator credential; try again later');
      return;
    }
    if (path === '/internal' || path.startsWith('/internal/') || NOT_FORWARDED.includes(path)) {
      deny(response, 404, 'NOT_FOUND', 'no such endpoint');
      return;
    }
    if (path === '/_gateway/restart') {
      void allowed(request.headers['x-acm-admin-token']).then((yes) => {
        if (request.method !== 'POST' || !yes) {
          countFailure(caller);
          deny(response, 401, 'ADMIN_REQUIRED', 'sign in first');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { restarting: true } }));
        onRestart();
      });
      return;
    }
    // Marked as coming from outside: the control service makes the first account, and
    // counts failed sign-ins, differently for those. A caller cannot take the mark off.
    const upstream = httpRequest(
      { host: core.hostname, port: core.port, method: request.method, path: request.url, headers: { ...request.headers, host: core.host, 'x-acm-remote': '1' } },
      (answer) => {
        if (answer.statusCode === 401) {
          countFailure(caller);
        }
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        // The event stream stays open; piping keeps it flowing both ways until either side ends.
        answer.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) {
        deny(response, 502, 'CORE_UNAVAILABLE', 'the control service did not answer');
      } else {
        response.destroy();
      }
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  return server;
}

/**
 * The optional ngrok component. It is not part of the installation: the
 * operator installs it from the console when remote access is wanted. It goes
 * into <data>/components/ngrok, apart from the program's own dependencies, so
 * installing or updating the program never adds or removes it.
 */
export function ngrokComponent(dataDir) {
  const folder = join(dataDir, 'components', 'ngrok');
  const marker = join(folder, 'node_modules', '@ngrok', 'ngrok', 'package.json');
  return {
    installed: () => existsSync(marker),

    /** Downloads the official SDK from the npm registry; rejects with the reason when that fails. */
    async install() {
      const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(npm)) {
        throw new Error(`npm was not found next to ${process.execPath}; install the component yourself with: npm install --prefix "${folder}" ${NGROK_PACKAGE}`);
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), `${JSON.stringify({ name: 'acm-ngrok-component', private: true }, null, 2)}\n`);
      await new Promise((done, fail) => {
        const child = spawn(process.execPath, [npm, 'install', NGROK_PACKAGE, '--prefix', folder, '--no-audit', '--no-fund', '--loglevel', 'error'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', fail);
        child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`npm install ended with code ${code}: ${output.trim().slice(-300)}`))));
      });
      if (!existsSync(marker)) {
        throw new Error('npm reported success but the component is not there');
      }
    },

    /** Opens a tunnel to a local port; resolves to {url, close()}. */
    async openTunnel({ port, authtoken, domain }) {
      const ngrok = createRequire(join(folder, 'package.json'))('@ngrok/ngrok');
      const listener = await ngrok.forward({ addr: `127.0.0.1:${port}`, authtoken, ...(domain === '' ? {} : { domain }) });
      return { url: listener.url(), close: () => listener.close() };
    },
  };
}

/**
 * Follows the remote-access settings of the control service: installs the
 * component when the operator asks for it, opens the tunnel when the settings
 * say so, closes it when they change, and reports what happened. `component`
 * is ngrokComponent(...) in production. Returns a function that closes
 * everything.
 */
export function startRemoteAccess({ coreUrl, adminToken, component, onRestart, intervalMs = 3000, say }) {
  let applied = '';
  let retryAt = 0;
  let proxy;
  let tunnel;
  let busy = false;
  let lastProblem = '';
  let installFailure;
  // What the control service was last told, so that it is told again only when something changed.
  let status = { state: 'stopped' };
  let reported = '';

  async function local(path, body) {
    const response = await fetch(`${coreUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken() },
      body: JSON.stringify(body ?? {}),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  async function report(next, installing = false) {
    status = next ?? status;
    const componentState = installing ? 'installing' : component.installed() ? 'installed' : installFailure === undefined ? 'missing' : 'failed';
    const body = { ...status, component: componentState, component_detail: componentState === 'failed' ? installFailure : undefined };
    const text = JSON.stringify(body);
    if (text !== reported) {
      await local('/api/v1/remote-access/report', body);
      reported = text;
    }
  }

  async function closeAll() {
    const closing = [tunnel?.close(), proxy === undefined ? undefined : new Promise((done) => { proxy.close(done); proxy.closeAllConnections(); })];
    tunnel = undefined;
    proxy = undefined;
    await Promise.allSettled(closing);
  }

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const config = await local('/api/v1/remote-access/config');
      if (config.install_requested && !component.installed()) {
        installFailure = undefined;
        await report(undefined, true);
        say('installing the ngrok component');
        try {
          await component.install();
          say('the ngrok component is installed');
        } catch (error) {
          installFailure = String(error.message ?? error).slice(0, 400);
          say(`the ngrok component could not be installed: ${installFailure}`);
        }
      }
      await report();

      const wanted = config.enabled && config.authtoken !== '' ? `${config.authtoken}\n${config.domain}` : '';
      // Unchanged settings need no action, except a failed start, which is tried again after its pause.
      if (wanted === applied && (wanted === '' || tunnel !== undefined || Date.now() < retryAt)) {
        return;
      }
      await closeAll();
      applied = wanted;
      retryAt = 0;
      if (wanted === '') {
        await report({ state: 'stopped' });
        say('remote access is off');
        return;
      }
      await report({ state: 'starting' });
      try {
        if (!component.installed()) {
          throw new Error('the ngrok component is not installed');
        }
        proxy = await startConsoleProxy({ coreUrl, adminToken, onRestart });
        // With no domain given, a name of this installation's own (agora-....ngrok.app). An ngrok
        // account that may not choose a name gets the address ngrok assigns it, and is told why.
        const own = config.domain === '' ? String(config.default_domain ?? '') : '';
        let refusal;
        try {
          tunnel = await component.openTunnel({ port: proxy.address().port, authtoken: config.authtoken, domain: config.domain === '' ? own : config.domain });
        } catch (error) {
          if (own === '') {
            throw error;
          }
          refusal = String(error.message ?? error).replaceAll(config.authtoken, '<authtoken>').slice(0, 300);
          tunnel = await component.openTunnel({ port: proxy.address().port, authtoken: config.authtoken, domain: '' });
        }
        await report({ state: 'online', public_url: tunnel.url, domain_fallback: refusal !== undefined, detail: refusal });
        say(refusal === undefined ? `remote access is on at ${tunnel.url}` : `remote access is on at ${tunnel.url} (the name ${own} was refused: ${refusal})`);
      } catch (error) {
        await closeAll();
        // Try again in a minute: the usual reasons are no network or a mistyped token.
        retryAt = Date.now() + 60000;
        const detail = String(error.message ?? error).replaceAll(config.authtoken, '<authtoken>').slice(0, 400);
        await report({ state: 'error', detail });
        say(`remote access could not start: ${detail}`);
      }
      lastProblem = '';
    } catch (error) {
      if (error.message !== lastProblem) {
        lastProblem = error.message;
        say(`remote access check failed: ${error.message}`);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  void round();
  return async () => {
    clearInterval(timer);
    await closeAll();
  };
}