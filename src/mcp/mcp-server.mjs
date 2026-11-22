// Shared by both MCP entry points (Streamable HTTP gateway and stdio bridge):
// builds an official-SDK MCP server whose tools forward to the control service.
// Neither entry point holds state or decides rules.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS, TOOLS } from './tools.mjs';

export const VERSION = '0.4.0';
export const HOST = '127.0.0.1';

/**
 * Returns callCore(token, tool, args): POSTs one agent command to the control
 * service and resolves to {status, ok, result} or {status, ok: false, error}.
 */
export function createCoreClient(coreUrl) {
  // `origin` is what the entry point knows about the conversation the call comes
  // from: {client, clientSession}. It lets the service tell an application's
  // conversations (its windows) apart.
  return async function callCore(token, tool, args, origin = {}) {
    let response;
    try {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      if (origin.client) {
        headers['x-acm-client'] = origin.client;
      }
      if (origin.clientSession) {
        headers['x-acm-client-session'] = String(origin.clientSession).slice(0, 250);
      }
      response = await fetch(`${coreUrl}/internal/v1/tools/${encodeURIComponent(tool)}`, {
        method: 'POST',
        headers,
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

/**
 * Which conversation of its application a call comes from, in the client's own
 * terms. Codex says it with every call (`meta` is the request's `_meta`); Claude
 * starts one bridge per conversation and says it in that bridge's environment
 * (`hint`). A client that says neither leaves it to the service to work out.
 */
export function conversationOf(meta, hint) {
  const turn = meta?.['x-codex-turn-metadata'];
  const named = meta?.threadId ?? turn?.thread_id ?? meta?.sessionId ?? hint;
  return typeof named === 'string' && named !== '' ? named : undefined;
}

function toolResult(envelope) {
  if (envelope.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(envelope.result) }], structuredContent: envelope.result };
  }
  const failure = { error: envelope.error };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
}

/**
 * `invoke(toolName, args, meta)` must resolve to a control-service envelope.
 * `meta` is the `_meta` of the client's request: some clients say there which
 * of their conversations the call comes from.
 */
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
      async (args, extra) => toolResult(await invoke(tool.name, args, extra?._meta)),
    );
  }
  return server;
}
