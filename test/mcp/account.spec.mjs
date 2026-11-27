// Test for signing in to the console with the operator's account: a name and a
// password in place of the credential file. The first account is made on the
// machine itself without signing in; after that it is the everyday way in, and
// the credential file stays the key of the installation.
//
// Run: node --test test/mcp/account.spec.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { freePort, startService } from '../support/service.mjs';
import { startConsoleProxy } from '../../src/mcp/remote.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-account-${runId}-`));
const dataDir = join(base, 'data');
let service;
let proxy;
let outside;
// Made up for this run; never a real password.
const NAME = `operator-${runId}`;
const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;
const NEXT = `pw-${randomBytes(9).toString('hex')}`;

/** One call as a browser makes it: `token` is whatever it has to present, `via` where it calls. */
async function call(method, path, { body, token, via } = {}) {
  const response = await fetch(`${via ?? service.coreUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-acm-admin-token': token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json();
  return { status: response.status, ok: envelope.ok, result: envelope.result, error: envelope.error };
}

describe("signing in with the operator's account", { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    // What a browser on another machine talks to when remote access is on.
    proxy = await startConsoleProxy({ coreUrl: service.coreUrl, adminToken: () => service.adminToken, onRestart: () => undefined });
    outside = `http://127.0.0.1:${proxy.address().port}`;
  });

  after(async () => {
    await new Promise((done) => proxy.close(done));
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('has no account at first, and lets only this machine make one', async () => {
    assert.deepEqual((await call('GET', '/api/v1/login')).result, { account: false, setup_allowed: true });
    assert.deepEqual((await call('GET', '/api/v1/login', { via: outside })).result, { account: false, setup_allowed: false });
    assert.equal((await call('GET', '/api/v1/bootstrap')).status, 401);
    // Nobody can sign in with an account that does not exist, and nobody outside can make it.
    assert.equal((await call('POST', '/api/v1/login', { body: { username: NAME, password: PASSWORD } })).error.code, 'LOGIN_FAILED');
    const fromOutside = await call('PUT', '/api/v1/account', { via: outside, body: { username: NAME, password: PASSWORD } });
    assert.deepEqual([fromOutside.status, fromOutside.error.code], [400, 'ACTION_NOT_ALLOWED']);
    // Nor a page of another site whose name was made to point at this machine: it reaches
    // the service, but it does not ask for this machine by its own address.
    const rebound = await new Promise((done, fail) => {
      const target = new URL(service.coreUrl);
      const sent = httpRequest({ host: target.hostname, port: target.port, method: 'PUT', path: '/api/v1/account', headers: { host: `evil.example:${target.port}`, 'content-type': 'application/json' } }, (answer) => {
        let text = '';
        answer.setEncoding('utf8').on('data', (chunk) => (text += chunk)).on('end', () => done({ status: answer.statusCode, body: JSON.parse(text) }));
      });
      sent.once('error', fail);
      sent.end(JSON.stringify({ username: NAME, password: PASSWORD }));
    });
    assert.deepEqual([rebound.status, rebound.body.error.code], [400, 'ACTION_NOT_ALLOWED']);
    assert.deepEqual((await call('GET', '/api/v1/login')).result, { account: false, setup_allowed: true });
  });

  it('makes the account with a name and a password of some length, and is signed in at once', async () => {
    const short = await call('PUT', '/api/v1/account', { body: { username: NAME, password: 'short' } });
    assert.deepEqual([short.error.code, short.error.details.reason], ['INVALID_ARGUMENT', 'password_short']);
    assert.equal((await call('PUT', '/api/v1/account', { body: { username: 'has space', password: PASSWORD } })).error.code, 'INVALID_ARGUMENT');
    const made = await call('PUT', '/api/v1/account', { body: { username: NAME, password: PASSWORD } });
    assert.equal(made.ok, true);
    assert.match(made.result.token, /^acmlogin_[0-9a-f]{64}$/);
    assert.equal(made.result.username, NAME);
    // That login is as good as the credential for the console's own calls.
    const state = await call('GET', '/api/v1/bootstrap', { token: made.result.token });
    assert.equal(state.status, 200);
    assert.deepEqual([state.result.account, state.result.authority], [{ username: NAME }, 'login']);
    assert.equal((await call('GET', '/api/v1/bootstrap', { token: service.adminToken })).result.authority, 'credential');
    // The password is stored as a slow salted hash, and no login in the clear.
    const stored = JSON.stringify(await service.admin('GET', '/api/v1/events?after=0&limit=1000'));
    assert.ok(!stored.includes(PASSWORD) && !stored.includes(made.result.token));
    // From now on the sign-in page asks for the account, and a second one cannot be made without signing in.
    assert.deepEqual((await call('GET', '/api/v1/login')).result, { account: true, setup_allowed: false });
    assert.equal((await call('PUT', '/api/v1/account', { body: { username: 'someone-else', password: PASSWORD } })).status, 401);
  });

  it('signs in with the name and the password, on this machine and from outside', async () => {
    const here = await call('POST', '/api/v1/login', { body: { username: NAME.toUpperCase(), password: PASSWORD } });
    assert.equal(here.ok, true, JSON.stringify(here.error));
    const there = await call('POST', '/api/v1/login', { via: outside, body: { username: NAME, password: PASSWORD } });
    assert.equal(there.ok, true);
    assert.notEqual(here.result.token, there.result.token);
    assert.equal((await call('GET', '/api/v1/session', { via: outside, token: there.result.token })).result.authority, 'login');
    // A wrong name and a wrong password look the same.
    const wrongName = await call('POST', '/api/v1/login', { body: { username: 'nobody', password: PASSWORD } });
    const wrongPassword = await call('POST', '/api/v1/login', { body: { username: NAME, password: `${PASSWORD}x` } });
    assert.deepEqual([wrongName.status, wrongName.error.code, wrongName.error.message], [wrongPassword.status, wrongPassword.error.code, wrongPassword.error.message]);
    assert.equal(wrongName.status, 401);
    // A made-up login is no login.
    assert.equal((await call('GET', '/api/v1/bootstrap', { token: `acmlogin_${'0'.repeat(64)}` })).status, 401);
    // Signing out ends that login and no other.
    assert.equal((await call('POST', '/api/v1/logout', { token: here.result.token, body: {} })).ok, true);
    assert.equal((await call('GET', '/api/v1/session', { token: here.result.token })).status, 401);
    assert.equal((await call('GET', '/api/v1/session', { token: there.result.token })).status, 200);
  });

  it('changes the password only for whoever knows the current one, and ends the other logins', async () => {
    const first = (await call('POST', '/api/v1/login', { body: { username: NAME, password: PASSWORD } })).result.token;
    const second = (await call('POST', '/api/v1/login', { body: { username: NAME, password: PASSWORD } })).result.token;
    const without = await call('PUT', '/api/v1/account', { token: first, body: { password: NEXT } });
    assert.deepEqual([without.status, without.error.details.reason], [401, 'current_password']);
    const wrong = await call('PUT', '/api/v1/account', { token: first, body: { password: NEXT, current_password: 'not-the-one' } });
    assert.equal(wrong.status, 401);
    const changed = await call('PUT', '/api/v1/account', { token: first, body: { password: NEXT, current_password: PASSWORD } });
    assert.equal(changed.ok, true, JSON.stringify(changed.error));
    assert.equal(changed.result.username, NAME);
    // The logins from before are over, the new one works, and so does the new password only.
    assert.equal((await call('GET', '/api/v1/session', { token: first })).status, 401);
    assert.equal((await call('GET', '/api/v1/session', { token: second })).status, 401);
    assert.equal((await call('GET', '/api/v1/session', { token: changed.result.token })).status, 200);
    assert.equal((await call('POST', '/api/v1/login', { body: { username: NAME, password: PASSWORD } })).status, 401);
    assert.equal((await call('POST', '/api/v1/login', { body: { username: NAME, password: NEXT } })).ok, true);
  });

  it('lets the credential of the installation set a forgotten password', async () => {
    const reset = await call('PUT', '/api/v1/account', { token: service.adminToken, body: { username: `${NAME}-2`, password: PASSWORD } });
    assert.equal(reset.ok, true, JSON.stringify(reset.error));
    assert.equal((await call('POST', '/api/v1/login', { body: { username: `${NAME}-2`, password: PASSWORD } })).ok, true);
    assert.equal((await call('POST', '/api/v1/login', { body: { username: NAME, password: NEXT } })).status, 401);
    // Signing out everywhere.
    const login = (await call('POST', '/api/v1/login', { body: { username: `${NAME}-2`, password: PASSWORD } })).result.token;
    assert.equal((await call('POST', '/api/v1/logout', { token: service.adminToken, body: { all: true } })).ok, true);
    assert.equal((await call('GET', '/api/v1/session', { token: login })).status, 401);
  });

  it('refuses sign-ins from outside after many wrong ones, and never locks out the machine itself', async () => {
    let refused;
    for (let attempt = 0; attempt < 25 && refused === undefined; attempt += 1) {
      const answer = await call('POST', '/api/v1/login', { via: outside, body: { username: `${NAME}-2`, password: `guess-${attempt}-xxxx` } });
      if (answer.status === 429) {
        refused = { attempt, answer };
      } else {
        assert.equal(answer.status, 401);
      }
    }
    assert.ok(refused !== undefined && refused.attempt >= 19, JSON.stringify(refused));
    // Now even the right password is refused from outside ...
    assert.equal((await call('POST', '/api/v1/login', { via: outside, body: { username: `${NAME}-2`, password: PASSWORD } })).status, 429);
    // ... while the person at the machine signs in as before.
    assert.equal((await call('POST', '/api/v1/login', { body: { username: `${NAME}-2`, password: PASSWORD } })).ok, true);
  });
});
