// Test for starting the service more than once: several clients may start it
// in the same instant, and exactly one service must come out of that, with the
// later starts ending quietly instead of taking the running one down.
//
// Run: node --test test/mcp/startup.spec.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-startup-${runId}-`));
const entry = join(repoRoot, 'src', 'mcp', 'server.mjs');
const cleanup = [];

/** Starts the gateway once more on the same ports; resolves to {code, output} when it ends. */
function secondStart(dataDir, ports) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, '--data-dir', dataDir, '--mcp-port', String(ports.mcpPort), '--core-port', String(ports.corePort)], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ACM_ALERTS: 'off' } });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

describe('starting the service', { concurrency: false }, () => {
  after(async () => {
    for (const stop of cleanup) {
      await stop().catch(() => undefined);
    }
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a start that finds the service running ends quietly and leaves it alone', async () => {
    const dataDir = join(base, 'one');
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    const service = await startService({ dataDir, ...ports });
    cleanup.push(() => service.stop());
    const before = await service.admin('GET', '/api/v1/bootstrap');

    const again = await secondStart(dataDir, ports);
    assert.equal(again.code, 0);
    assert.match(again.output, /a service already runs on 127\.0\.0\.1:\d+; this start is not needed/);
    assert.ok(!again.output.includes('acm-core'), 'the late start must not start a control service of its own');

    // The running service did not notice: same process, same store, still answering.
    assert.equal(service.child.exitCode, null);
    const still = await service.admin('GET', '/api/v1/bootstrap');
    assert.equal(still.event_watermark, before.event_watermark);
    assert.ok((await fetch(`${service.mcpBase}/healthz`)).ok);
    assert.ok(!service.output.join('').includes('exited unexpectedly'));
  });

  it('clients that start it in the same instant end up with one service', async () => {
    const dataDir = join(base, 'many');
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    const instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    const call = (client) => promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, 'call', 'get_session'], { env: { ...process.env, ACM_ALERTS: 'off' } });
    cleanup.push(async () => {
      const token = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();
      await fetch(`http://127.0.0.1:${ports.mcpPort}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': token, connection: 'close' } });
      await new Promise((done) => setTimeout(done, 1500));
    });

    // Nothing runs yet; five clients need it at once.
    const answers = await Promise.all(['claude', 'codex', 'antigravity', 'grok', 'helper'].map(call));
    for (const { stdout } of answers) {
      assert.equal(JSON.parse(stdout).result.status, 'active');
    }
    // One service, which nobody knocked over on the way.
    const log = readFileSync(join(dataDir, 'logs', 'service.log'), 'utf8');
    assert.equal(log.match(/acm-mcp \S+ listening/g).length, 1);
    assert.ok(!log.includes('exited unexpectedly') && !log.includes('EADDRINUSE'), log);
    const token = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();
    const state = await (await fetch(`http://127.0.0.1:${ports.corePort}/api/v1/bootstrap`, { headers: { 'x-acm-admin-token': token } })).json();
    assert.equal(state.result.sessions.filter((entry) => entry.status === 'active').length, 5);
  });
});
