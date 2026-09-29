/**
 * MCP Client - HTTP bridge to call MCP tools via JSON-RPC 2.0
 * 
 * This utility provides a simple interface to call any MCP tool
 * on the Lambda backend using HTTP POST requests.
 */

import { envTimeoutMs, fetchWithTimeout } from './fetch-timeout';

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;

/**
 * Per-request deadlines. API Gateway cuts an integration off at ~29s by
 * default, so 60s for a tool call only matters if the stage allows longer;
 * it's there so a hung connection can't stall a run indefinitely.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;

export interface McpCallOptions {
  /** Aborts the request (e.g. the agent run was stopped). */
  signal?: AbortSignal;
  /** Overrides MCP_TOOL_TIMEOUT_MS for this call. */
  timeoutMs?: number;
}

/**
 * A bare "Forbidden" with no JSON error body is the standard response from
 * an AWS API Gateway stage that requires an API key (x-api-key) or a
 * resource policy that rejects unauthenticated requests — this client used
 * to send neither. Set MCP_API_KEY if your API Gateway stage has a usage
 * plan / API key requirement, or MCP_AUTH_TOKEN if it's fronted by a
 * Lambda authorizer expecting a bearer token instead.
 */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.MCP_API_KEY) headers['x-api-key'] = process.env.MCP_API_KEY;
  if (process.env.MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${process.env.MCP_AUTH_TOKEN}`;
  return headers;
}

async function describeError(response: Response): Promise<string> {
  const bodyText = await response.text().catch(() => '');
  const bodyPreview = bodyText ? ` — ${bodyText.slice(0, 300)}` : '';
  return `HTTP ${response.status}: ${response.statusText}${bodyPreview}`;
}

export interface MCPRequest {
  jsonrpc: string;
  id: string;
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface MCPResponse<T = unknown> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

/**
 * Call an MCP tool with arguments
 * @param toolName - Name of the MCP tool to call
 * @param args - Tool arguments as a record
 * @returns The tool result or throws an error
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: McpCallOptions = {}
): Promise<unknown> {
  if (!MCP_ENDPOINT) {
    throw new Error(
      'MCP_ENDPOINT_URL is not set. Please configure it in .env.local'
    );
  }

  const requestId = `harness-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const payload: MCPRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  try {
    const result = (await fetchWithTimeout(
      MCP_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: opts.timeoutMs ?? envTimeoutMs('MCP_TOOL_TIMEOUT_MS', DEFAULT_TOOL_TIMEOUT_MS),
        label: `MCP tool ${toolName}`,
        signal: opts.signal,
      },
      async (response) => {
        if (!response.ok) throw new Error(await describeError(response));
        return response.json();
      }
    )) as MCPResponse;

    // Handle JSON-RPC error response
    if (result.error) {
      throw new Error(
        `MCP Error [${result.error.code}]: ${result.error.message}` +
        (result.error.data ? ` - ${JSON.stringify(result.error.data)}` : '')
      );
    }

    // Return the result
    if (result.result === undefined) {
      throw new Error('Invalid MCP response: no result field');
    }

    return unwrapToolResult(result.result);
  } catch (error) {
    // Re-throw known errors
    if (error instanceof Error) {
      throw error;
    }
    // Wrap unknown errors
    throw new Error(`MCP call failed: ${String(error)}`);
  }
}

/**
 * Unwrap the MCP tool response envelope.
 *
 * The Lambda handler returns tool results in the standard MCP format:
 *   { content: [{ type: "text", text: "<json-encoded tool output>" }] }
 *
 * The actual tool payload (e.g. { solution_config: {...}, is_valid: true })
 * is JSON-stringified inside content[0].text. This function extracts and
 * parses it so callers get the real tool output directly, instead of the
 * raw MCP envelope.
 */
function unwrapToolResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) {
    const content = (raw as { content: Array<{ type?: string; text?: string }> }).content;
    if (content.length > 0 && content[0]?.type === 'text' && typeof content[0]?.text === 'string') {
      const text = content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        // Not JSON (e.g. plain string tool output) — return as-is
        return text;
      }
    }
  }

  // Already unwrapped (or an unexpected shape) — return as-is
  return raw;
}

/**
 * List all available MCP tools
 */
export async function listMcpTools(): Promise<unknown> {
  if (!MCP_ENDPOINT) {
    throw new Error(
      'MCP_ENDPOINT_URL is not set. Please configure it in .env.local'
    );
  }

  const requestId = `harness-list-${Date.now()}`;

  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/list',
    params: {},
  };

  try {
    const result = (await fetchWithTimeout(
      MCP_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(payload),
      },
      { timeoutMs: envTimeoutMs('MCP_LIST_TIMEOUT_MS', DEFAULT_LIST_TIMEOUT_MS), label: 'MCP tools/list' },
      async (response) => {
        if (!response.ok) throw new Error(await describeError(response));
        return response.json();
      }
    )) as MCPResponse;

    if (result.error) {
      throw new Error(
        `MCP Error [${result.error.code}]: ${result.error.message}`
      );
    }

    return result.result;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to list MCP tools: ${String(error)}`);
  }
}
