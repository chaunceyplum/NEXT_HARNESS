/**
 * MCP tool catalog + AI SDK tool adapter.
 *
 * Fetches the tool list from the MCP server once (tools/list), caches it in
 * memory for the life of the process, and can wrap any subset of it as an
 * AI SDK ToolSet backed by callMcpTool(). This is what lets the agent call
 * arbitrary MCP tools without us hand-writing a wrapper per tool.
 */

import { callMcpTool, listMcpTools } from '@/lib/mcp-client';
import { jsonSchema, tool, type ToolSet } from 'ai';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

let catalogPromise: Promise<McpToolDefinition[]> | null = null;

/** Fetch (and cache) the full MCP tool catalog. Safe to call repeatedly. */
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
        return raw as McpToolDefinition[];
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
 * Wrap a set of MCP tool definitions as an AI SDK ToolSet. Each tool's
 * `execute` calls straight through to the MCP server via callMcpTool — the
 * model only ever sees the schemas you hand it here, which is what makes
 * tool-shortlisting (lib/llm/tool-retrieval.ts) effective: pass a narrow
 * `defs` list and the model literally cannot call anything outside it.
 */
export function buildAiTools(defs: McpToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description || `MCP tool: ${def.name}`,
      // MCP inputSchema is already JSON Schema; jsonSchema() takes it as-is
      // without requiring a hand-written Zod schema per tool.
      inputSchema: jsonSchema(def.inputSchema as never),
      execute: async (input: unknown) => {
        return callMcpTool(def.name, (input as Record<string, unknown>) ?? {});
      },
    });
  }
  return tools;
}
