// Shared helpers for the process-level tests: start the service through its
// normal entry (src/mcp/server.mjs), drive the operator API, connect MCP
// clients and read the event stream.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// These tests may themselves be run from inside a client conversation (Claude sets
// this variable). Nothing they start may take that conversation for its own.
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.ACM_CLIENT_SESSION;
// No test starts a real client on this machine: the command lines of Codex and
// Antigravity are replaced by stand-ins where a test is about idle delivery.
process.env.ACM_DISPATCH_BUILTIN = 'off';
// Nor does a test run read the conversations this machine's own clients have on record.
process.env.ACM_DISCOVER = 'off';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'src', 'mcp', 'server.mjs');

/** Ask the OS for a currently free loopback port. */
export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * Start acm-mcp (which starts acm-core) on the given data directory.
 * Resolves once the MCP endpoint answers its health check.
 */
export async function startService({ dataDir, mcpPort, corePort }) {
  const output = [];
  const child = spawn(process.execPath, [entry, '--data-dir', dataDir, '--mcp-port', String(mcpPort), '--core-port', String(corePort)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No system notifications from a test run, unless the test is about them.
    env: { ...process.env, ACM_ALERTS: process.env.ACM_ALERTS ?? 'off' },
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const exited = new Promise((done) => child.once('exit', (code) => done(code)));

  const mcpBase = `http://127.0.0.1:${mcpPort}`;
  const coreUrl = `http://127.0.0.1:${corePort}`;
  let healthy = false;
  // Up to 45 seconds: on a machine that is busy with other work (or scanning a binary that
  // was linked a moment ago) the control service can take that long to answer.
  for (let attempt = 0; attempt < 450 && !healthy && child.exitCode === null; attempt += 1) {
    try {
      healthy = (await fetch(`${mcpBase}/healthz`)).ok;
    } catch {
      healthy = false;
    }
    if (!healthy) {
      // Not listening yet, or listening and still starting the control service.
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (!healthy) {
    child.kill();
    throw new Error(`service did not start:\n${output.join('')}`);
  }
  const adminToken = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();

  /** Operator API call; returns the unwrapped result or throws with the business error attached. */
  async function admin(method, path, body) {
    const response = await fetch(`${coreUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
      const error = new Error(`${envelope.error.code}: ${envelope.error.message}`);
      error.code = envelope.error.code;
      error.status = response.status;
      error.details = envelope.error.details;
      throw error;
    }
    return envelope.result;
  }

  /** Graceful stop through the gateway; resolves with the process exit code. */
  async function stop() {
    // A caller that blocked its event loop (spawnSync) may hold a pooled socket the
    // server already closed. Shutdown is idempotent, so a failed send is retried.
    for (let attempt = 1; child.exitCode === null; attempt += 1) {
      try {
        await fetch(`${mcpBase}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken, connection: 'close' } });
        break;
      } catch (error) {
        if (attempt >= 5) {
          throw error;
        }
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    return exited;
  }

  return { child, mcpUrl: `${mcpBase}/mcp`, mcpBase, coreUrl, adminToken, admin, stop, exited, output };
}

/** Connect an MCP SDK client that presents `token` as its session credential. */
export async function connectClient(mcpUrl, token, name = 'acm-test-client') {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '0.0.1' });
  await client.connect(transport);
  return client;
}

/** Call a tool and normalize the outcome to {ok, result} or {ok: false, code, error}. */
export async function callTool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    const error = response.structuredContent?.error ?? { code: 'TOOL_ERROR', message: response.content?.[0]?.text ?? '' };
    return { ok: false, code: error.code, error };
  }
  return { ok: true, result: response.structuredContent };
}

/**
 * Read the operator SSE stream until `count` events arrived or `timeoutMs`
 * passed, then drop the connection. Resumes after `lastEventId` when given.
 */
export async function readEventStream({ coreUrl, adminToken, lastEventId, count, timeoutMs = 4000 }) {
  const controller = new AbortController();
  const headers = { accept: 'text/event-stream', 'x-acm-admin-token': adminToken };
  if (lastEventId !== undefined) {
    headers['last-event-id'] = String(lastEventId);
  }
  const events = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${coreUrl}/api/v1/events`, { headers, signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data !== undefined) {
          events.push(JSON.parse(data.slice('data: '.length)));
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (events.length >= count) {
        break;
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}
