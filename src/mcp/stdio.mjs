#!/usr/bin/env node
// acm-stdio: MCP stdio bridge for desktop clients that launch MCP servers as a
// local command (Antigravity, Codex and Claude do). It exposes the same tools
// as the HTTP endpoint and forwards every call to the one running control
// service, so all clients share a single store.
//
// Identity, service start and registration are shared with the command line;
// see bridge.mjs. A client whose agent cannot load a local MCP server but can
// run local commands uses cli.mjs instead.
//
//   node src/mcp/stdio.mjs [--client NAME] [--label TEXT] [--project ID] [--identity-file PATH]
//                          [--data-dir DIR] [--mcp-port 8765] [--core-port 8766] [--no-autostart]
//
// --client says which application this is (claude, codex, antigravity, grok,
// or any other lowercase name); it selects the agent the session belongs to
// and the file the identity is kept in, so each application is one session.
//
// The bridge holds no tool definitions on the way to the client: the tool list
// and every call are answered by the running service (see relay in bridge.mjs).
// So when the service is updated, the tools this client sees follow by
// themselves - the client is told that the list changed and asks again - and
// the bridge never has to be restarted for that.
//
// stdout carries the MCP protocol; every diagnostic goes to stderr.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, takeBridgeOptions } from './bridge.mjs';
import { VERSION, buildMcpServer } from './mcp-server.mjs';
import { SERVER_INSTRUCTIONS } from './tools.mjs';

const argv = process.argv.slice(2);
const options = takeBridgeOptions(argv);
if (argv.length > 0) {
  throw new Error(`unknown option ${argv[0]}`);
}

const say = (line) => console.error(`[acm-stdio] ${line}`);
const bridge = createBridge({ ...options, relays: true }, say);
await bridge.start();

/** A control-service error in the shape every tool reports one. */
const failed = (error) => {
  const failure = { error };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
};

/** The tools as this file's own copy describes them: only for when the service cannot be asked. */
async function ownTools() {
  const [near, far] = InMemoryTransport.createLinkedPair();
  const local = buildMcpServer(async () => ({ ok: false, error: { code: 'CORE_UNAVAILABLE', message: 'the conversation service is not reachable', details: {} } }));
  const reader = new Client({ name: 'acm-stdio', version: VERSION });
  await local.connect(near);
  await reader.connect(far);
  try {
    return await reader.listTools();
  } finally {
    await reader.close();
    await local.close();
  }
}

// How to use the service is its to say as well; this file's copy is the fallback.
const hello = await bridge.relay('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acm-stdio', version: VERSION } });
const server = new Server(
  { name: 'agent-conversation-mcp', version: VERSION },
  { capabilities: { tools: { listChanged: true } }, instructions: hello.result?.instructions ?? SERVER_INSTRUCTIONS },
);

// The contract version of the list the client last received.
let listed;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const answer = await bridge.relay('tools/list', {});
  if (answer.result === undefined) {
    say(`tool list taken from this bridge's own copy: ${answer.unavailable ?? answer.refused?.message ?? answer.error?.message}`);
    return ownTools();
  }
  listed = answer.contract;
  void bridge.served(answer.result.tools.length, answer.contract).catch(() => {});
  return answer.result;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // What the client says about the conversation the call comes from goes along
  // untouched; the service reads it. A progress token is not for the service.
  const { progressToken: _dropped, ...meta } = request.params._meta ?? {};
  const answer = await bridge.relay('tools/call', { name: request.params.name, arguments: request.params.arguments ?? {}, _meta: meta });
  if (answer.unavailable !== undefined) {
    return failed({ code: 'CORE_UNAVAILABLE', message: answer.unavailable, details: {} });
  }
  if (answer.refused !== undefined) {
    return failed(answer.refused);
  }
  if (answer.error !== undefined) {
    throw new McpError(Number.isInteger(answer.error.code) ? answer.error.code : ErrorCode.InternalError, String(answer.error.message ?? 'the request failed'));
  }
  if (answer.contract !== undefined && listed !== undefined && answer.contract !== listed) {
    // The service was updated since the client listed the tools: have it ask again.
    listed = answer.contract;
    say(`the tools changed (contract ${answer.contract}); telling the client to list them again`);
    void server.sendToolListChanged().catch(() => {});
  }
  return answer.result;
});

await server.connect(new StdioServerTransport());
say(`ready as ${bridge.client}, relaying to ${bridge.coreUrl}`);
