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
// stdout carries the MCP protocol; every diagnostic goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, takeBridgeOptions } from './bridge.mjs';
import { buildMcpServer } from './mcp-server.mjs';

const argv = process.argv.slice(2);
const options = takeBridgeOptions(argv);
if (argv.length > 0) {
  throw new Error(`unknown option ${argv[0]}`);
}

const bridge = createBridge(options, (line) => console.error(`[acm-stdio] ${line}`));
await bridge.start();
const server = buildMcpServer(bridge.invoke);
await server.connect(new StdioServerTransport());
console.error(`[acm-stdio] ready as ${bridge.client}, forwarding to ${bridge.coreUrl}`);
