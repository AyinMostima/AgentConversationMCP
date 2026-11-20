// Test for the alerts (src/mcp/alerts.mjs): which states of the routes count as
// a problem worth telling the person about, that each is announced once, and
// that the operator's switch silences the notification but not the log.
//
// Run: node --test test/mcp/alerts.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { findProblems } from '../../src/mcp/alerts.mjs';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-alerts-${runId}-`));
const dataDir = join(base, 'data');
const shownFile = join(base, 'shown.jsonl');
const standIn = join(base, 'notify-stand-in.mjs');
// Stands in for the system notification: appends what it was asked to show.
writeFileSync(standIn, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(shownFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
process.env.ACM_ALERTS = 'on';
process.env.ACM_ALERT_INTERVAL_MS = '300';
process.env.ACM_ALERT_COMMAND = JSON.stringify([process.execPath, standIn]);
process.env.ACM_WAKE_INTERVAL_MS = '250';

let service;
let instance;
let hookStatus = 401;
const hookServer = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    response.writeHead(hookStatus, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
const cli = async (client, ...args) => JSON.parse((await promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args])).stdout).result;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const shown = () => (existsSync(shownFile) ? readFileSync(shownFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
async function waitFor(check, timeoutMs, what) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await check()) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const minute = 60 * 1000;
const at = (msAgo) => new Date(Date.parse('2026-11-20T12:00:00.000Z') - msAgo).toISOString();
const now = Date.parse('2026-11-20T12:00:00.000Z');
/** An operator view with one bot host; `change` adjusts it for a case. */
function view(change = {}) {
  return {
    agents: [{ agent_id: 'agt_grok', display_name: 'Grok Bot' }],
    sessions: [{ session_id: 'ses_g', agent_id: 'agt_grok', label: 'grok-bot', status: 'active', host_seen_at: at(30 * minute), urgent_dispatch: true }],
    bot_requests: [],
    wake_hooks: [],
    client_hooks: [],
    settings: { alerts_enabled: true },
    ...change,
  };
}
const queued = (msAgo) => ({ request_id: `brq_${msAgo}`, status: 'queued', created_at: at(msAgo), host: { session_id: 'ses_g' } });
const hook = (fields) => ({ session_id: 'ses_g', enabled: true, last_status: null, last_detail: null, last_ok_at: null, last_attempt_at: null, ...fields });

describe('alerts', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    await new Promise((done) => hookServer.listen(0, '127.0.0.1', done));
  });

  after(async () => {
    hookServer.close();
    hookServer.closeAllConnections();
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('finds what needs a person and nothing else', () => {
    const keys = (state) => findProblems(state, now).map((problem) => problem.key.split(':')[0]);
    // Nothing waits, or what waits is fresh, or the host is listening: quiet.
    assert.deepEqual(keys(view()), []);
    assert.deepEqual(keys(view({ bot_requests: [queued(2 * minute)] })), []);
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], sessions: [{ ...view().sessions[0], host_seen_at: at(20 * 1000) }] })), []);
    // Work waits, nobody listens, nothing triggers it.
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)] })), ['no-trigger']);
    // A trigger exists and works: quiet, even with work waiting a moment.
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], wake_hooks: [hook({ last_status: 'ok', last_ok_at: at(1 * minute) })] })), []);
    // Refused: said with what the answer means.
    const refused = findProblems(view({ wake_hooks: [hook({ last_status: 'failed', last_detail: 'HTTP 401' })] }), now);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].key, 'wake-failed:ses_g:401');
    assert.match(refused[0].text, /webhook key/i);
    // The network swallowed it: retried by itself, so not a problem for the first minutes.
    const lost = (detail, okAgo, attemptAgo) => view({ wake_hooks: [hook({ last_status: 'failed', last_detail: detail, last_ok_at: at(okAgo), last_attempt_at: at(attemptAgo) })] });
    assert.deepEqual(keys(lost('UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted addresses: 1.1.1.1:443, 2.2.2.2:443)', 2 * minute, 10 * 1000)), []);
    // Nothing got through for more than five minutes and it is still being tried: now it is one.
    assert.deepEqual(keys(lost('UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted addresses: 1.1.1.1:443, 2.2.2.2:443)', 6 * minute, 10 * 1000)), ['wake-lost']);
    // The same outage worded differently is the same problem, so it is announced once.
    const first = findProblems(lost('UND_ERR_CONNECT_TIMEOUT (attempted addresses: 1.1.1.1:443, 2.2.2.2:443)', 6 * minute, 10 * 1000), now)[0];
    const second = findProblems(lost('UND_ERR_CONNECT_TIMEOUT (attempted addresses: 2.2.2.2:443, 1.1.1.1:443)', 7 * minute, 10 * 1000), now)[0];
    assert.equal(first.key, second.key);
    assert.match(first.text, /retrying automatically/i);
    // Long since the last try: the work is gone, nobody is trying, nothing to tell.
    assert.deepEqual(keys(lost('ETIMEDOUT', 60 * minute, 30 * minute)), []);
    // Accepted long ago, work still waits, the host never came since.
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], wake_hooks: [hook({ last_status: 'ok', last_ok_at: at(5 * minute) })] })), ['wake-silent']);
    // It came after the signal: that is working.
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], wake_hooks: [hook({ last_status: 'ok', last_ok_at: at(5 * minute) })], sessions: [{ ...view().sessions[0], host_seen_at: at(4 * minute) }] })), []);
    // A switched-off trigger counts as none; a session that is not active is nobody's problem.
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], wake_hooks: [hook({ enabled: false, last_status: 'failed' })] })), ['no-trigger']);
    assert.deepEqual(keys(view({ bot_requests: [queued(9 * minute)], sessions: [{ ...view().sessions[0], status: 'revoked' }] })), []);
    // An urgent message that could not be handed to the client's command.
    const failedDelivery = { session_id: 'ses_g', last_urgent: { route: 'command', status: 'failed', at: at(minute), detail: 'exit code 3' } };
    assert.deepEqual(keys(view({ client_hooks: [failedDelivery] })), ['dispatch-failed']);
    assert.deepEqual(keys(view({ client_hooks: [failedDelivery], sessions: [{ ...view().sessions[0], urgent_dispatch: false }] })), []);
  });

  it('announces a refused trigger once, and only logs it when notifications are off', async () => {
    const bot = (await cli('watched-bot', 'call', 'get_session')).session_id;
    await service.admin('PUT', `/api/v1/sessions/${bot}/wake-hook`, { url: `http://127.0.0.1:${hookServer.address().port}/r`, key: 'wk_alert_key' });
    await service.admin('POST', `/api/v1/sessions/${bot}/wake-hook/test`);
    await waitFor(() => shown().length === 1, 8000, 'the notification');
    const [title, text] = shown()[0];
    assert.match(title, /watched-bot/);
    assert.match(text, /webhook key/i);
    // The same problem is not announced over and over.
    await sleep(1200);
    assert.equal(shown().length, 1);
    assert.match(readFileSync(join(dataDir, 'logs', 'alerts.log'), 'utf8'), /watched-bot/);

    // It goes away and comes back while notifications are switched off: logged, not shown.
    assert.equal((await service.admin('PUT', '/api/v1/settings', { alerts_enabled: false })).alerts_enabled, false);
    hookStatus = 200;
    await service.admin('POST', `/api/v1/sessions/${bot}/wake-hook/test`);
    await waitFor(async () => (await service.admin('GET', '/api/v1/bootstrap')).wake_hooks[0].last_status === 'ok', 6000, 'the trigger to work again');
    await sleep(700);
    hookStatus = 403;
    await service.admin('POST', `/api/v1/sessions/${bot}/wake-hook/test`);
    await waitFor(() => readFileSync(join(dataDir, 'logs', 'alerts.log'), 'utf8').trim().split('\n').length === 2, 8000, 'the second problem to be logged');
    await sleep(600);
    assert.equal(shown().length, 1);
    await assert.rejects(service.admin('PUT', '/api/v1/settings', { alerts_enabled: 'yes' }), { code: 'INVALID_ARGUMENT' });
  });
});
