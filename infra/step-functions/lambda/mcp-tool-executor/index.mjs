/**
 * Step Functions Task target for the tool-executor state machine.
 *
 * Input:  { toolName: string, arguments: object }
 * Output: the unwrapped MCP tool result (same shape callMcpTool() in the
 *         Next.js app returns), on success.
 *
 * Mirrors the JSON-RPC call + envelope-unwrap logic in lib/mcp-client.ts —
 * keep the two in sync if the MCP wire format changes.
 */

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;
const MCP_API_KEY = process.env.MCP_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 90000);

/** Thrown for network/transport failures — the state machine's Retry block matches on this name. */
class TransientToolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TransientToolError';
  }
}

/** Thrown for a real tool failure (bad args, MCP-side error, non-2xx) — not retried by the state machine. */
class ToolExecutionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ToolExecutionError';
  }
}

function authHeaders() {
  const headers = {};
  if (MCP_API_KEY) headers['x-api-key'] = MCP_API_KEY;
  if (MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;
  return headers;
}

function unwrapToolResult(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    const content = raw.content;
    if (content.length > 0 && content[0]?.type === 'text' && typeof content[0]?.text === 'string') {
      const text = content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return raw;
}

export const handler = async (event) => {
  const { toolName, arguments: toolArgs } = event ?? {};

  if (!MCP_ENDPOINT) {
    throw new ToolExecutionError('MCP_ENDPOINT_URL is not configured on the Lambda function');
  }
  if (!toolName || typeof toolName !== 'string') {
    throw new ToolExecutionError(`Invalid event: expected { toolName, arguments }, got ${JSON.stringify(event)}`);
  }

  const requestId = `sfn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs ?? {} },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TransientToolError(`MCP request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const message = `HTTP ${response.status}: ${response.statusText}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ''}`;
    // 5xx from API Gateway/Lambda is transient (cold start, throttling); 4xx is a real failure.
    if (response.status >= 500) throw new TransientToolError(message);
    throw new ToolExecutionError(message);
  }

  const result = await response.json();

  if (result.error) {
    throw new ToolExecutionError(
      `MCP Error [${result.error.code}]: ${result.error.message}` +
        (result.error.data ? ` - ${JSON.stringify(result.error.data)}` : '')
    );
  }

  if (result.result === undefined) {
    throw new ToolExecutionError('Invalid MCP response: no result field');
  }

  return unwrapToolResult(result.result);
};
