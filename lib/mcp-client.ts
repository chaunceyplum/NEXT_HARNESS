/**
 * MCP Client - HTTP bridge to call MCP tools via JSON-RPC 2.0
 * 
 * This utility provides a simple interface to call any MCP tool
 * on the Lambda backend using HTTP POST requests.
 */

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;

export interface MCPRequest {
  jsonrpc: string;
  id: string;
  method: string;
  params: {
    name: string;
    arguments: Record<string, any>;
  };
}

export interface MCPResponse<T = any> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: Record<string, any>;
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
  args: Record<string, any>
): Promise<any> {
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
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${response.statusText}`
      );
    }

    const result: MCPResponse = await response.json();

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

    return result.result;
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
 * List all available MCP tools
 */
export async function listMcpTools(): Promise<any> {
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
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result: MCPResponse = await response.json();

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
