// Test for what the operator chooses about how the console shows who is who:
// faces on or off, a picture of the operator's own in the place of a built-in
// one, and the names of the applications and of the operator.
//
// Run: node --test test/mcp/appearance.spec.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { freePort, repoRoot, startService } from '../support/service.mjs';

const runId = randomBytes(4).toString('hex');
const base = mkdtempSync(join(tmpdir(), `acm-appearance-${runId}-`));
const dataDir = join(base, 'data');
let service;
let instance;

// A real picture, and a larger one than any thumbnail: it has to arrive whole.
const original = readFileSync(join(repoRoot, 'ui', 'public', 'avatars', 'operator.png'));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

async function cli(client, ...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [join(repoRoot, 'src', 'mcp', 'cli.mjs'), '--client', client, ...instance, '--no-autostart', ...args]);
  return JSON.parse(stdout).result;
}
const upload = (slot, bytes, token = service.adminToken) =>
  fetch(`${service.coreUrl}/api/v1/avatars/${slot}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-acm-admin-token': token }, body: bytes });

describe('faces and names in the console', { concurrency: false }, () => {
  before(async () => {
    const ports = { mcpPort: await freePort(), corePort: await freePort() };
    service = await startService({ dataDir, ...ports });
    instance = ['--data-dir', dataDir, '--core-port', String(ports.corePort), '--mcp-port', String(ports.mcpPort)];
    await cli('claude', 'call', 'get_session');
    await cli('codex', 'call', 'get_session');
  });

  after(async () => {
    await service.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('shows faces unless the operator switches them off', async () => {
    const state = await service.admin('GET', '/api/v1/bootstrap');
    assert.equal(state.settings.avatars_enabled, true);
    assert.deepEqual(state.avatars, {});
    assert.equal(state.settings.operator_name, '');
    assert.equal((await service.admin('PUT', '/api/v1/settings', { avatars_enabled: false })).avatars_enabled, false);
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.avatars_enabled, false);
    assert.equal((await service.admin('PUT', '/api/v1/settings', { avatars_enabled: true })).avatars_enabled, true);
  });

  it('takes a picture of the operator\'s own as it is, serves it back byte for byte, and gives the built-in one back', async () => {
    const stored = await (await upload('anthropic', original)).json();
    assert.equal(stored.ok, true);
    assert.equal(stored.result.custom, true);
    assert.equal(stored.result.kind, 'png');
    assert.deepEqual(Object.keys((await service.admin('GET', '/api/v1/bootstrap')).avatars), ['anthropic']);
    // What an <img> gets: the same bytes, no smaller copy, and no credential needed.
    const shown = await fetch(`${service.coreUrl}/avatars/custom/anthropic?v=${encodeURIComponent(stored.result.version)}`);
    assert.equal(shown.status, 200);
    assert.match(shown.headers.get('content-type'), /^image\/png/);
    assert.match(shown.headers.get('cache-control'), /immutable/);
    assert.ok(Buffer.from(await shown.arrayBuffer()).equals(original), 'the picture comes back unchanged');
    assert.ok(existsSync(join(dataDir, 'avatars', 'anthropic.png')));

    // A new picture in the same place replaces the old file and gets a new address.
    await new Promise((done) => setTimeout(done, 20));
    const again = (await (await upload('anthropic', png)).json()).result;
    assert.notEqual(again.version, stored.result.version);
    assert.deepEqual(readdirSync(join(dataDir, 'avatars')), ['anthropic.png']);
    assert.equal(Buffer.from(await (await fetch(`${service.coreUrl}/avatars/custom/anthropic`)).arrayBuffer()).length, png.length);

    // Back to the built-in one.
    assert.equal((await service.admin('DELETE', '/api/v1/avatars/anthropic')).custom, false);
    assert.deepEqual((await service.admin('GET', '/api/v1/bootstrap')).avatars, {});
    assert.equal((await fetch(`${service.coreUrl}/avatars/custom/anthropic`)).status, 404);
    assert.deepEqual(readdirSync(join(dataDir, 'avatars')), []);
  });

  it('accepts pictures only, from the operator only, under plain names only', async () => {
    assert.equal((await upload('operator', Buffer.from('<svg onload="alert(1)"/>'))).status, 400);
    assert.equal((await upload('operator', Buffer.from('MZ not a picture at all'))).status, 400);
    assert.equal((await upload('operator', png, 'acmadmin_wrong')).status, 401);
    // A name that tries to leave the folder is no name of an avatar, whichever way the address is read.
    assert.ok([400, 404].includes((await upload('..%2F..%2Fadmin-token', png)).status));
    assert.equal((await upload('Has.Dots', png)).status, 400);
    const sneaky = await fetch(`${service.coreUrl}/avatars/custom/..%2Fadmin-token.txt`);
    assert.ok([400, 404].includes(sneaky.status));
    assert.ok(!(await sneaky.text()).includes(service.adminToken));
    assert.ok(!existsSync(join(dataDir, 'avatars')) || readdirSync(join(dataDir, 'avatars')).length === 0, 'nothing was written');
    // No tool lets a session change any of it.
    const tools = (await cli('claude', 'tools')).map((tool) => tool.name);
    assert.ok(!tools.some((name) => /avatar|rename_agent|update_agent/.test(name)));
  });

  it('renames an application and the operator, everywhere they are named', async () => {
    const state = await service.admin('GET', '/api/v1/bootstrap');
    const codex = state.agents.find((agent) => agent.provider === 'openai');
    const renamed = await service.admin('PUT', `/api/v1/agents/${codex.agent_id}`, { display_name: 'Miko' });
    assert.equal(renamed.display_name, 'Miko');
    await assert.rejects(service.admin('PUT', `/api/v1/agents/${codex.agent_id}`, { display_name: '' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(service.admin('PUT', '/api/v1/agents/agt_nobody', { display_name: 'X' }), { code: 'NOT_FOUND' });
    // Other sessions see the new name; reconnecting the application does not put the old one back.
    await cli('codex', 'call', 'get_session');
    const roster = (await cli('claude', 'call', 'check_in')).project_sessions;
    assert.ok(roster.some((entry) => entry.display_name === 'Miko'), JSON.stringify(roster).slice(0, 300));

    assert.equal((await service.admin('PUT', '/api/v1/settings', { operator_name: 'Ayin' })).operator_name, 'Ayin');
    assert.equal((await service.admin('GET', '/api/v1/bootstrap')).settings.operator_name, 'Ayin');
    assert.equal((await service.admin('PUT', '/api/v1/settings', { operator_name: '' })).operator_name, '');
    await assert.rejects(service.admin('PUT', '/api/v1/settings', { operator_name: 'x'.repeat(41) }), { code: 'INVALID_ARGUMENT' });
    // The shared rules can be taken away the same way.
    assert.equal((await service.admin('PUT', '/api/v1/settings', { shared_rules: 'One rule.' })).shared_rules, 'One rule.');
    assert.equal((await service.admin('PUT', '/api/v1/settings', { shared_rules: '' })).shared_rules, '');
  });
});
