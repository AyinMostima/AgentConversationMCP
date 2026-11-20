// Sends the wake signals the control service says are due.
//
// A wake signal tells a session that cannot be reached from this machine (Grok
// Bot's agent runs elsewhere) that work is waiting, through the entry point its
// vendor documents: an HTTP POST to the routine's webhook address with
// `Authorization: Bearer <key>` and an optional JSON body. This is an outgoing
// call only; nothing on this machine is opened to a network, and the body
// carries counts, never conversation content.
//
// The control service decides when a signal is due (see src/core/wake.hpp);
// this module makes the call and reports what the other side answered.
//
// Getting through. The call goes out the way this machine reaches the
// internet: through the proxy it is configured with (HTTPS_PROXY, or the
// Windows system proxy), and directly when there is none or the proxy does not
// answer. When no way gets through, the same signal is tried once more after a
// moment before it is reported as lost; the control service then asks for it
// again by itself, at growing intervals, for as long as the work waits. Only an
// answer from the other side ends that: 200 means a run was started, any other
// status is a refusal and is reported as such without retrying here.
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

const CALL_TIMEOUT_MS = 15000;
const SECOND_ROUND_AFTER_MS = 3000;
const LOCAL = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;

let systemProxy = { read: 0, value: undefined };
/** The proxy Windows is configured with, as "http://host:port"; read at most once a minute. */
function windowsProxy() {
  if (process.platform !== 'win32') {
    return undefined;
  }
  if (Date.now() - systemProxy.read < 60000) {
    return systemProxy.value;
  }
  let value;
  try {
    const out = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }).stdout ?? '';
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1];
    if (enabled && server !== undefined) {
      // Either "host:port" for everything or "http=host:port;https=host:port".
      const chosen = server.includes('=') ? (/(?:^|;)https=([^;]+)/i.exec(server)?.[1] ?? /(?:^|;)http=([^;]+)/i.exec(server)?.[1]) : server;
      value = chosen === undefined ? undefined : chosen.includes('://') ? chosen : `http://${chosen}`;
    }
  } catch {
    value = undefined;
  }
  systemProxy = { read: Date.now(), value };
  return value;
}

/**
 * The proxy to use for `url`, or undefined for a direct call. ACM_WAKE_PROXY
 * names one outright ("off" forces direct); otherwise the usual environment
 * variables, then the system setting. Addresses on this machine never go
 * through a proxy, unless ACM_WAKE_PROXY_LOCAL=1 says so (tests).
 */
export function proxyFor(url, env = process.env) {
  const target = new URL(url);
  if (LOCAL.test(target.hostname) && env.ACM_WAKE_PROXY_LOCAL !== '1') {
    return undefined;
  }
  const named = env.ACM_WAKE_PROXY;
  if (named === 'off') {
    return undefined;
  }
  const value = named || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || windowsProxy();
  if (!value) {
    return undefined;
  }
  try {
    const proxy = new URL(value.includes('://') ? value : `http://${value}`);
    return proxy.protocol === 'http:' ? proxy : undefined;
  } catch {
    return undefined;
  }
}

/** One POST over core modules, optionally through an HTTP proxy (CONNECT tunnel). Resolves to the status code. */
function post(url, headers, body, proxy) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })), CALL_TIMEOUT_MS);
    const settle = (action) => (value) => {
      clearTimeout(timer);
      action(value);
    };
    const send = (socket) => {
      const options = { host: target.hostname, port, path: `${target.pathname}${target.search}`, method: 'POST', headers: { ...headers, host: target.host, 'content-length': Buffer.byteLength(body) } };
      if (socket !== undefined) {
        options.createConnection = () => socket;
      }
      const call = (secure && socket === undefined ? httpsRequest : httpRequest)(options, (response) => {
        response.resume();
        response.on('end', () => settle(done)(response.statusCode));
      });
      call.on('error', settle(fail));
      call.end(body);
    };
    if (proxy === undefined) {
      send(undefined);
      return;
    }
    const tunnelHeaders = { host: `${target.hostname}:${port}` };
    if (proxy.username !== '') {
      tunnelHeaders['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    }
    const tunnel = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${target.hostname}:${port}`, headers: tunnelHeaders });
    tunnel.on('error', settle(fail));
    tunnel.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        settle(fail)(Object.assign(new Error(`the proxy answered ${response.statusCode}`), { code: 'EPROXY' }));
        return;
      }
      if (!secure) {
        send(socket);
        return;
      }
      const encrypted = tlsConnect({ socket, servername: target.hostname });
      encrypted.on('error', settle(fail));
      encrypted.on('secureConnect', () => send(encrypted));
    });
    tunnel.end();
  });
}

/**
 * Sends one signal. Resolves to {ok, http_status?, detail?, route?}: `route`
 * says which way got an answer. A refusal by the other side comes back at once;
 * only "nothing got through" is tried a second time.
 */
export async function sendSignal(signal, env = process.env) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${signal.key}` };
  const body = JSON.stringify(signal.body);
  const proxy = proxyFor(signal.url, env);
  const routes = proxy === undefined ? [undefined] : [proxy, undefined];
  let problem = '';
  for (let round = 0; round < 2; round += 1) {
    if (round > 0) {
      await new Promise((done) => setTimeout(done, Number(env.ACM_WAKE_SECOND_ROUND_MS ?? SECOND_ROUND_AFTER_MS)));
    }
    for (const route of routes) {
      const name = route === undefined ? 'direct' : 'proxy';
      try {
        // A redirect is not followed: the key must not go to another address.
        const status = await post(signal.url, headers, body, route);
        return status === 200 ? { ok: true, http_status: 200, route: name } : { ok: false, http_status: status, detail: `HTTP ${status}`, route: name };
      } catch (error) {
        problem = `${error.code ?? error.name}: ${error.message}`.slice(0, 200);
      }
    }
  }
  return { ok: false, detail: `${problem} (${routes.length === 2 ? 'through the proxy and directly' : 'directly'}, tried twice)`.slice(0, 300) };
}

/**
 * Starts the periodic check. `adminToken()` returns the operator credential of
 * the local service; `say(line)` receives one-line diagnostics. Returns a
 * function that stops the check.
 */
export function startWakeDispatcher({ coreUrl, adminToken, intervalMs = 5000, say }) {
  let busy = false;
  let lastProblem = '';

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

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const { signals } = await local('/api/v1/wake/claim');
      for (const signal of signals) {
        const outcome = await sendSignal(signal);
        await local('/api/v1/wake/report', { attempt_id: signal.attempt_id, ok: outcome.ok, http_status: outcome.http_status, detail: outcome.detail });
        say(`wake signal for ${signal.session_id}: ${outcome.ok ? `accepted (${outcome.route})` : outcome.detail}`);
      }
      lastProblem = '';
    } catch (error) {
      // The same problem every few seconds is said once.
      if (error.message !== lastProblem) {
        lastProblem = error.message;
        say(`wake check failed: ${error.message}`);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
