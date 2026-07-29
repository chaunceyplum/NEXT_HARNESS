/**
 * MCP tool catalog + AI SDK tool-stub adapter — catalog/schema concerns
 * only. Deliberately does NOT import lib/llm/tool-execution.ts (which pulls
 * in commit-validation.ts -> the `typescript` package for the pre-commit
 * syntax check): init-run and agent-step only ever need tool schemas, not
 * execution, and the `typescript` compiler is a multi-MB dependency that
 * has no business in their Lambda bundles. Keep that boundary — see
 * tool-execution.ts's own doc comment before merging these back together.
 */

import { listMcpTools } from '@/lib/mcp-client';
import { LOCAL_TOOL_DEFINITIONS } from './local-tools';
import { jsonSchema, tool, type ToolSet } from 'ai';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

let catalogPromise: Promise<McpToolDefinition[]> | null = null;

/** Fetch (and cache) the full tool catalog: MCP's tools/list plus the locally-defined tools. Safe to call repeatedly. */
export async function getMcpToolCatalog(): Promise<McpToolDefinition[]> {
  if (!catalogPromise) {
    catalogPromise = listMcpTools()
      .then((result) => {
        const obj = result as { tools?: unknown } | unknown[] | null | undefined;
        const raw = Array.isArray(obj) ? obj : (obj?.tools ?? []);
        if (!Array.isArray(raw)) {
          throw new Error(
            `Unexpected tools/list response shape: ${JSON.stringify(result).slice(0, 200)}`
          );
        }
        return [...(raw as McpToolDefinition[]), ...LOCAL_TOOL_DEFINITIONS];
      })
      .catch((err) => {
        // Don't cache a failed fetch — next call should retry.
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

/** Force the next getMcpToolCatalog() call to refetch (e.g. after MCP redeploy). */
export function invalidateToolCatalogCache(): void {
  catalogPromise = null;
}

export async function getToolDefinition(name: string): Promise<McpToolDefinition | undefined> {
  const catalog = await getMcpToolCatalog();
  return catalog.find((t) => t.name === name);
}

/**
 * Tool definitions with NO execute function — used by the agent-step
 * Lambda (aws/lambdas/agent-step). Without an execute function,
 * generateText() stops after emitting tool-call parts instead of running
 * them; the exec-tools Lambda runs them afterwards via
 * lib/llm/tool-execution.ts's executeMcpToolWithRetry. This is what lets
 * Step Functions checkpoint between "model decided what to call" and
 * "tools actually ran".
 */
export function buildToolStubs(defs: McpToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description || `MCP tool: ${def.name}`,
      inputSchema: jsonSchema(def.inputSchema as never),
    });
  }
  return tools;
}
