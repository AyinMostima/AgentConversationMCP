// Test for sending a wake signal (src/mcp/wake.mjs): which way out it takes,
// what counts as an answer, and that it keeps trying when nothing gets through.
//
// Run: node --test test/mcp/wake.spec.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { proxyFor, sendSignal } from '../../src/mcp/wake.mjs';

const received = [];
let status = 200;
// Stands in for the vendor's webhook endpoint.
const target = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(status, status === 302 ? { location: 'http://127.0.0.1:1/elsewhere' } : { 'content-type': 'application/json' });
    response.end('{}');
  });
});
// Stands in for the machine's proxy: an HTTP proxy that tunnels on CONNECT.
const tunnelled = [];
let proxyAnswers = true;
const proxy = createServer();
proxy.on('connect', (request, client) => {
  tunnelled.push(request.url);
  if (!proxyAnswers) {
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    return;
  }
  const [host, port] = request.url.split(':');
  const upstream = connect(Number(port), host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done));
const signalTo = (port) => ({ url: `http://127.0.0.1:${port}/routines/r_1?x=1`, key: 'wk_route_key', body: { source: 'acm', pending_requests: 2, unread_direct_messages: 0 } });
let viaProxy;
const quick = { ACM_WAKE_SECOND_ROUND_MS: '50' };

describe('sending a wake signal', { concurrency: false }, () => {
  before(async () => {
    await listen(target);
    await listen(proxy);
    viaProxy = { ...quick, ACM_WAKE_PROXY: `http://127.0.0.1:${proxy.address().port}`, ACM_WAKE_PROXY_LOCAL: '1' };
  });

  after(() => {
    for (const server of [target, proxy]) {
      server.close();
      server.closeAllConnections();
    }
  });

  it('chooses the way out like the rest of the machine does', () => {
    const outside = 'https://hooks.example.test/r';
    assert.equal(proxyFor(outside, { ACM_WAKE_PROXY: 'off', HTTPS_PROXY: 'http://127.0.0.1:9' }), undefined);
    assert.equal(proxyFor(outside, { ACM_WAKE_PROXY: 'off' }), undefined);
    assert.equal(proxyFor(outside, { HTTPS_PROXY: 'http://127.0.0.1:8888' }).port, '8888');
    assert.equal(proxyFor(outside, { HTTP_PROXY: '10.0.0.1:8080' }).host, '10.0.0.1:8080');
    assert.equal(proxyFor(outside, { ACM_WAKE_PROXY: 'http://user:pw@proxy.example.test:3128', HTTPS_PROXY: 'http://other:1' }).username, 'user');
    // An address on this machine is never sent through a proxy; a proxy of another kind is not used.
    assert.equal(proxyFor('http://127.0.0.1:8080/r', { HTTPS_PROXY: 'http://127.0.0.1:8888' }), undefined);
    assert.equal(proxyFor(outside, { ACM_WAKE_PROXY: 'socks5://127.0.0.1:1080' }), undefined);
  });

  it('goes out directly when there is no proxy, and only 200 counts as accepted', async () => {
    const direct = { ...quick, ACM_WAKE_PROXY: 'off' };
    assert.deepEqual(await sendSignal(signalTo(target.address().port), direct), { ok: true, http_status: 200, route: 'direct' });
    assert.deepEqual(received.at(-1), { method: 'POST', path: '/routines/r_1?x=1', authorization: 'Bearer wk_route_key', body: '{"source":"acm","pending_requests":2,"unread_direct_messages":0}' });
    // A refusal is an answer: reported at once, not sent again.
    const before = received.length;
    for (const refused of [401, 429, 500, 302]) {
      status = refused;
      assert.deepEqual(await sendSignal(signalTo(target.address().port), direct), { ok: false, http_status: refused, detail: `HTTP ${refused}`, route: 'direct' });
    }
    assert.equal(received.length, before + 4, 'a redirect is not followed and nothing is sent twice');
    status = 200;
  });

  it('takes the proxy when one is configured and falls back to a direct call', async () => {
    const through = await sendSignal(signalTo(target.address().port), viaProxy);
    assert.deepEqual(through, { ok: true, http_status: 200, route: 'proxy' });
    assert.deepEqual(tunnelled, [`127.0.0.1:${target.address().port}`]);
    assert.equal(received.at(-1).authorization, 'Bearer wk_route_key');
    // The proxy refuses to tunnel: the same signal still arrives, directly.
    proxyAnswers = false;
    assert.deepEqual(await sendSignal(signalTo(target.address().port), viaProxy), { ok: true, http_status: 200, route: 'direct' });
    proxyAnswers = true;
    // The proxy is not there at all: likewise.
    assert.deepEqual(await sendSignal(signalTo(target.address().port), { ...viaProxy, ACM_WAKE_PROXY: 'http://127.0.0.1:9' }), { ok: true, http_status: 200, route: 'direct' });
  });

  it('tries every way twice before saying that nothing got through', async () => {
    const tries = tunnelled.length;
    const lost = await sendSignal(signalTo(9), viaProxy);
    assert.equal(lost.ok, false);
    assert.equal(lost.http_status, undefined);
    assert.match(lost.detail, /through the proxy and directly, tried twice/);
    assert.ok(!lost.detail.startsWith('HTTP '), 'a lost signal must not look like a refusal');
    assert.equal(tunnelled.length, tries + 2);
    const alone = await sendSignal(signalTo(9), { ...quick, ACM_WAKE_PROXY: 'off' });
    assert.match(alone.detail, /ECONNREFUSED.*\(directly, tried twice\)/);
    // The key is in nothing that is reported.
    assert.ok(!JSON.stringify([lost, alone]).includes('wk_route_key'));
  });
});
