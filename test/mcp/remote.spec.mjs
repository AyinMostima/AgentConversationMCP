// Test for remote access to the console (src/mcp/remote.mjs) against the real
// service: it is off by default, what the tunnel exposes is the console and its
// operator API only, the tunnel credential is never read back, wrong operator
// credentials are locked out, and a restart from outside brings it back.
//
// The tunnel itself is replaced by a stand-in (ACM_TUNNEL_STUB=1): the "public"
// address is the local proxy the tunnel would point at, so no network is used
// and everything the tunnel would expose is exercised.
//
// Run: node --test test/mcp/remote.spec.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { freePort, repoRoot, startService } from '../support/service.mjs';

process.env.ACM_TUNNEL_STUB = '1';
// The stand-in tunnel refuses these names, as ngrok refuses a chosen name to a free account.
process.env.ACM_TUNNEL_STUB_REFUSE = '\\.ngrok\\.app$';
process.env.ACM_REMOTE_INTERVAL_MS = '200';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-remote-${runId}-`));
const evidence = { runId, startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (id, detail) => evidence.checks.push({ id, ...detail });
const AUTHTOKEN = `ngrok_test_token_${runId}`;
let service;
let publicUrl;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const remote = async () => (await service.admin('GET', '/api/v1/bootstrap')).remote_access;
async function waitFor(check, timeoutMs, what) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await check()) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** A call as it arrives through the tunnel, from one outside address. */
const outside = (path, { method = 'GET', token, from = '203.0.113.7', body } = {}) =>
  fetch(`${publicUrl}${path}`, {
    method,
    headers: { 'x-forwarded-for': from, ...(token === undefined ? {} : { 'x-acm-admin-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('remote access to the console', { concurrency: false }, () => {
  before(async () => {
    service = await startService({ dataDir: join(base, 'data'), mcpPort: await freePort(), corePort: await freePort() });
  });

  after(async () => {
    if (service.child.exitCode !== null) {
      // The restart test replaced the service with a process that is not a child of this test.
      await fetch(`${service.mcpBase}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': service.adminToken, connection: 'close' } }).catch(() => undefined);
      await waitFor(async () => !(await fetch(`${service.coreUrl}/healthz`).then((response) => response.ok, () => false)), 8000, 'the replacement service to stop');
    }
    evidence.finalExitCode = service.child.exitCode === null ? await service.stop() : service.child.exitCode;
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(join(repoRoot, 'test-output', 'reports'), { recursive: true });
    writeFileSync(join(repoRoot, 'test-output', 'reports', 'mcp-remote.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('is off until the operator enters a tunnel credential and switches it on', async () => {
    // A new installation has no tunnel component and nothing switched on.
    const fresh = await remote();
    // With no domain given the tunnel will ask for a name of this installation's own.
    assert.match(fresh.default_domain, /^agora-[0-9a-f]{6}\.ngrok\.app$/);
    assert.deepEqual(fresh, { component: 'missing', component_detail: null, default_domain: fresh.default_domain, detail: null, domain: null, domain_fallback: false, enabled: false, has_authtoken: false, public_url: null, state: 'stopped' });
    await assert.rejects(service.admin('PUT', '/api/v1/remote-access', { enabled: true }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(service.admin('PUT', '/api/v1/remote-access', { domain: 'https://bad/path' }), { code: 'INVALID_ARGUMENT' });

    // Storing the credential alone opens nothing, and it cannot be switched on without the component.
    // What cannot be a token is refused when it is saved, with the reason: the dashboard's
    // list of authtokens shows and copies the id of a credential, not the token.
    const id = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n';
    for (const [pasted, reason] of [
      [`cr_${id}`, 'credential_id'],
      [`ak_${id}`, 'api_key_id'],
      [`rd_${id}`, 'resource_id'],
      [`ngrok config add-authtoken ${id}_${id.slice(0, 21)}`, 'characters'],
      [`"${id}_${id.slice(0, 21)}"`, 'characters'],
    ]) {
      const refusal = await service.admin('PUT', '/api/v1/remote-access', { authtoken: pasted }).then(() => null, (error) => error);
      assert.equal(refusal?.code, 'INVALID_ARGUMENT', pasted.slice(0, 12));
      assert.equal(refusal.details.reason, reason);
    }
    assert.match((await service.admin('PUT', '/api/v1/remote-access', { authtoken: `cr_${id}` }).catch((error) => error)).message, /Your Authtoken/);
    assert.equal((await remote()).has_authtoken, false);
    // A token as ngrok issues them, and the shapes it used before, are taken as they are.
    assert.equal((await service.admin('PUT', '/api/v1/remote-access', { authtoken: `${id}_${id.slice(0, 21)}` })).has_authtoken, true);
    const stored = await service.admin('PUT', '/api/v1/remote-access', { authtoken: AUTHTOKEN });
    assert.deepEqual([stored.enabled, stored.has_authtoken, stored.state], [false, true, 'stopped']);
    await assert.rejects(service.admin('PUT', '/api/v1/remote-access', { enabled: true }), { code: 'INVALID_ARGUMENT', message: /not installed/ });
    await sleep(600);
    assert.equal((await remote()).public_url, null);

    // The operator asks for the component; the gateway installs it and says so.
    assert.equal((await service.admin('POST', '/api/v1/remote-access/install')).component, 'installing');
    await waitFor(async () => (await remote()).component === 'installed', 5000, 'the component to be installed');
    assert.deepEqual([(await remote()).state, (await remote()).enabled], ['stopped', false]);
    // Asking again when it is there changes nothing.
    assert.equal((await service.admin('POST', '/api/v1/remote-access/install')).component, 'installed');

    await service.admin('PUT', '/api/v1/remote-access', { enabled: true });
    await waitFor(async () => (await remote()).state === 'online', 5000, 'the tunnel to open');
    publicUrl = (await remote()).public_url;
    assert.match(publicUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(publicUrl, service.coreUrl);
    // It asked for its AGORA name first; this account may not have one, so it is online at
    // the address it was assigned, and the console can say why.
    const asked = readFileSync(join(base, 'data', 'components', 'stub-domains.log'), 'utf8').split('\n').slice(0, -1);
    assert.deepEqual(asked, [fresh.default_domain, '']);
    const online = await remote();
    assert.equal(online.domain_fallback, true);
    assert.match(online.detail, /may not bind agora-/);
    assert.equal(online.default_domain, fresh.default_domain);
    // A name the operator chose is asked for as it is, and not replaced when it is refused.
    await service.admin('PUT', '/api/v1/remote-access', { domain: 'chosen.ngrok.app' });
    await waitFor(async () => (await remote()).state === 'error', 5000, 'the chosen name to be refused');
    assert.match((await remote()).detail, /may not bind chosen\.ngrok\.app/);
    assert.equal((await remote()).domain_fallback, false);
    await service.admin('PUT', '/api/v1/remote-access', { domain: 'agora.example.test' });
    await waitFor(async () => (await remote()).state === 'online', 5000, 'the tunnel to open under the chosen name');
    assert.deepEqual([(await remote()).domain, (await remote()).domain_fallback, (await remote()).detail], ['agora.example.test', false, null]);
    publicUrl = (await remote()).public_url;
    // The credential is in nothing the console or the event log shows.
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/bootstrap')).includes(AUTHTOKEN));
    assert.ok(!JSON.stringify(await service.admin('GET', '/api/v1/events?after=0&limit=1000')).includes(AUTHTOKEN));
    note('opt-in', { default: 'stopped, component missing', enabledWithoutCredential: 'INVALID_ARGUMENT', enabledWithoutComponent: 'INVALID_ARGUMENT', componentInstalledOnRequest: true, credentialAloneOpensNothing: true, credentialReadBack: false });
  });

  it('exposes the console and its operator API, and nothing else', async () => {
    const page = await outside('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    // The operator API works exactly as it does locally: with the credential, and not without.
    assert.equal((await outside('/api/v1/bootstrap')).status, 401);
    const boot = await outside('/api/v1/bootstrap', { token: service.adminToken });
    assert.equal(boot.status, 200);
    assert.equal((await boot.json()).result.remote_access.state, 'online');
    const created = await outside('/api/v1/projects', { method: 'POST', token: service.adminToken, body: { project_id: 'prj_remote', name: 'Created from outside' } });
    assert.equal(created.status, 200);

    // What agents and bridges use stays on this machine: not reachable through the tunnel...
    for (const [path, method] of [['/internal/v1/enroll', 'POST'], ['/internal/v1/tools/get_session', 'POST'], ['/internal/v1/shutdown', 'POST'], ['/internal', 'GET']]) {
      const refused = await outside(path, { method, token: service.adminToken, body: method === 'POST' ? {} : undefined });
      assert.equal(refused.status, 404, `${path} must not be forwarded`);
    }
    // ...while the same call made locally still works.
    const selfIssued = `acm_${randomBytes(24).toString('hex')}`;
    const local = await fetch(`${service.coreUrl}/internal/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${selfIssued}` }, body: '{"client":"codex"}' });
    assert.equal(local.status, 200);
    // The endpoints that hand credentials to the gateway are not forwarded either, even with the operator credential.
    for (const path of ['/api/v1/remote-access/config', '/api/v1/wake/claim', '/api/v1/wake/report', '/api/v1/remote-access/report']) {
      assert.equal((await outside(path, { method: 'POST', token: service.adminToken, body: {} })).status, 404, `${path} must not be forwarded`);
    }
    // The live event stream comes through.
    const stream = await fetch(`${publicUrl}/api/v1/events`, { headers: { accept: 'text/event-stream', 'x-acm-admin-token': service.adminToken, 'last-event-id': '0' } });
    assert.equal(stream.status, 200);
    const first = new TextDecoder().decode((await stream.body.getReader().read()).value);
    assert.match(first, /data: \{/);
    await stream.body.cancel().catch(() => undefined);
    note('exposure', { console: 200, apiWithoutCredential: 401, apiWithCredential: 200, internalEndpoints: 404, gatewayOnlyEndpoints: 404, eventStream: 'forwarded' });
  });

  it('locks out an address that keeps presenting a wrong operator credential', async () => {
    const attacker = { token: 'acmadmin_wrong', from: '198.51.100.23' };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal((await outside('/api/v1/bootstrap', attacker)).status, 401);
    }
    assert.equal((await outside('/api/v1/bootstrap', attacker)).status, 429);
    // Even the right credential does not help that address now; another address is unaffected.
    assert.equal((await outside('/api/v1/bootstrap', { token: service.adminToken, from: attacker.from })).status, 429);
    assert.equal((await outside('/api/v1/bootstrap', { token: service.adminToken })).status, 200);
    note('lockout', { wrongCredentials: 20, then: 429, otherAddresses: 'unaffected' });
  });

  it('comes back after a restart from outside and closes when switched off', async () => {
    assert.equal((await outside('/_gateway/restart', { method: 'POST' })).status, 401);
    assert.equal((await outside('/_gateway/restart', { method: 'POST', token: service.adminToken })).status, 200);
    assert.equal(await service.exited, 0, 'the old process must stop cleanly');
    await waitFor(async () => fetch(`${service.coreUrl}/healthz`).then((response) => response.ok, () => false), 20000, 'the replacement to answer');
    // The setting survived, so the replacement opens the tunnel again by itself.
    await waitFor(async () => (await remote()).state === 'online', 8000, 'the tunnel to reopen');
    const previous = publicUrl;
    publicUrl = (await remote()).public_url;
    assert.equal((await outside('/api/v1/bootstrap', { token: service.adminToken })).status, 200);
    await assert.rejects(fetch(`${previous}/`), 'the address of the stopped process must be gone');

    const off = await service.admin('PUT', '/api/v1/remote-access', { enabled: false });
    assert.equal(off.enabled, false);
    await waitFor(async () => (await remote()).state === 'stopped', 5000, 'the tunnel to close');
    assert.equal((await remote()).public_url, null);
    await assert.rejects(fetch(`${publicUrl}/`), 'nothing may listen once remote access is off');
    const changes = (await service.admin('GET', '/api/v1/events?after=0&limit=1000')).events.filter((event) => event.event_type === 'remote.changed');
    assert.ok(changes.length >= 4);
    note('lifecycle', { restartFromOutside: 'tunnel reopened by itself', switchedOff: 'address closed', state: 'stopped' });
  });
});
