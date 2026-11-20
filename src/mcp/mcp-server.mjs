// Shared by both MCP entry points (Streamable HTTP gateway and stdio bridge):
// builds an official-SDK MCP server whose tools forward to the control service.
// Neither entry point holds state or decides rules.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS, TOOLS } from './tools.mjs';

export const VERSION = '0.3.0';
export const HOST = '127.0.0.1';

/**
 * Returns callCore(token, tool, args): POSTs one agent command to the control
 * service and resolves to {status, ok, result} or {status, ok: false, error}.
 */
export function createCoreClient(coreUrl) {
  return async function callCore(token, tool, args) {
    let response;
    try {
      response = await fetch(`${coreUrl}/internal/v1/tools/${encodeURIComponent(tool)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(args ?? {}),
      });
    } catch (error) {
      return {
        status: 503,
        ok: false,
        error: { code: 'CORE_UNAVAILABLE', message: `the conversation service is not reachable at ${coreUrl}; start it with "npm start" (${error.message})`, details: {} },
      };
    }
    return { status: response.status, ...(await response.json()) };
  };
}

function toolResult(envelope) {
  if (envelope.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(envelope.result) }], structuredContent: envelope.result };
  }
  const failure = { error: envelope.error };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
}

/** `invoke(toolName, args)` must resolve to a control-service envelope. */
export function buildMcpServer(invoke) {
  const server = new McpServer({ name: 'agent-conversation-mcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args) => toolResult(await invoke(tool.name, args)),
    );
  }
  return server;
}
