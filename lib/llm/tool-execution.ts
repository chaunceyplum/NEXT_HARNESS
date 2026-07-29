/**
 * Tool *execution* — separate from lib/llm/tool-catalog.ts's schema/catalog
 * concerns specifically so that only Lambdas that actually run tools
 * (exec-tools, and the old in-process sync path) pull in this module's
 * dependency chain: commit-validation.ts -> the `typescript` package,
 * several MB, needed only for the pre-commit syntax check. init-run and
 * agent-step only ever need buildToolStubs()/getMcpToolCatalog() from
 * tool-catalog.ts and must NOT import anything here, or their bundles
 * balloon for a dependency they never use — this happened once already
 * (esbuild does not tree-shake it out when both live in one file/module,
 * because tool-catalog.ts's other exports are still "live" from those
 * entry points' perspective). Keep this file's only consumers as
 * exec-tools and lib/llm/agent.ts (the sync `?sync=1` path).
 */

import { callMcpTool } from '@/lib/mcp-client';
import { executeLocalTool, isLocalTool } from './local-tools';
import { validateBeforeCommit } from './commit-validation';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { McpToolDefinition } from './tool-catalog';

/** Local tools first (no network round-trip), then the MCP server — with the pre-commit syntax check gating msb_github_commit_code either way. */
async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (isLocalTool(toolName)) {
    return executeLocalTool(toolName, args);
  }
  await validateBeforeCommit(toolName, args);
  return callMcpTool(toolName, args);
}

/**
 * Knowledge-search tools used to ground a retry. Never wrapped in their own
 * retry logic (that would recurse) and never chosen as the RAG tool for
 * themselves.
 */
const RAG_TOOLS = new Set([
  'search_adobe_knowledge',
  'search_aws_knowledge',
  'search_data_eng_knowledge',
  'search_braze_knowledge',
  'search_zeta_knowledge',
  'search_all_agents',
  'query_rag_db',
  'knowledge_base_health',
]);

/** Pick which knowledge base is most likely to explain a given tool's failure. */
function pickRagTool(toolName: string, available: Set<string>): string | undefined {
  const candidates = toolName.startsWith('aws_')
    ? ['search_aws_knowledge']
    : toolName.startsWith('databricks_') || toolName.startsWith('snowflake_')
      ? ['search_data_eng_knowledge']
      : ['search_adobe_knowledge'];
  return candidates.find((c) => available.has(c)) ?? [...available].find((c) => RAG_TOOLS.has(c));
}

export interface RetryAttemptRecord {
  attempt: number;
  error: string;
  raggedBefore?: {
    tool: string;
    query: string;
    findings?: unknown;
    lookupError?: string;
  };
}

export interface BuildAiToolsOptions {
  /** Extra retries after the first failed attempt, each preceded by a RAG lookup. 0 disables retrying. */
  maxRetries?: number;
}

export interface ExecuteMcpToolWithRetryOptions {
  /** Extra retries after the first failed attempt, each preceded by a RAG lookup. 0 disables retrying. */
  maxRetries: number;
  /** Names of tools in this run's selected set — used to pick a plausible grounding tool for the RAG lookup. */
  availableNames: Set<string>;
}

/**
 * Calls one MCP (or local) tool with the RAG-consulting retry behavior,
 * independent of the AI SDK tool wrapper below. Shared by the in-process
 * agent loop (via buildAiTools) and the exec-tools Lambda (aws/lambdas/
 * exec-tools), so both retry identically instead of the Lambda
 * re-implementing this.
 *
 * On failure, before retrying, this consults the relevant knowledge-search
 * tool (query built from the tool name, its arguments, and the error) so
 * the retry — and the model's own next move if the retry also fails — has
 * more to go on than "it errored." Retry history (including what the RAG
 * lookup found) rides along on the eventual result/error so it's visible
 * in the trace, not just to the model.
 *
 * RAG tools call themselves — never retry-with-RAG-lookup those, or a
 * failing search would try to "ground itself" recursively.
 */
export async function executeMcpToolWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  opts: ExecuteMcpToolWithRetryOptions
): Promise<unknown> {
  const { maxRetries, availableNames } = opts;
  const isRagTool = RAG_TOOLS.has(toolName);

  if (isRagTool || maxRetries <= 0) {
    return callTool(toolName, args);
  }

  const attempts: RetryAttemptRecord[] = [];
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callTool(toolName, args);
      if (attempts.length === 0) return result;
      // Succeeded after retrying — attach retry history without
      // disturbing the shape callers rely on (e.g. agent.ts reading
      // output.execution_id directly off msb_execute_solution's result).
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ...(result as Record<string, unknown>), _retryHistory: attempts };
      }
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < maxRetries) {
        const ragTool = pickRagTool(toolName, availableNames);
        const record: RetryAttemptRecord = { attempt: attempt + 1, error: message };
        if (ragTool) {
          const query = `Tool "${toolName}" failed with error: ${message}. Arguments used: ${JSON.stringify(args)}. What is the correct usage or known constraint here?`;
          record.raggedBefore = { tool: ragTool, query };
          try {
            record.raggedBefore.findings = await callMcpTool(ragTool, { query });
          } catch (ragErr) {
            record.raggedBefore.lookupError = ragErr instanceof Error ? ragErr.message : String(ragErr);
          }
        }
        attempts.push(record);
      } else {
        attempts.push({ attempt: attempt + 1, error: message });
      }
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${toolName} failed after ${attempts.length} attempt(s): ${finalMessage}\n` +
      `Retry history: ${JSON.stringify(attempts)}`
  );
}

/**
 * Wrap a set of MCP tool definitions as an AI SDK ToolSet. Each tool's
 * `execute` calls straight through to executeMcpToolWithRetry — the model
 * only ever sees the schemas you hand it here, which is what makes
 * tool-shortlisting (lib/llm/tool-retrieval.ts) effective: pass a narrow
 * `defs` list and the model literally cannot call anything outside it.
 */
export function buildAiTools(defs: McpToolDefinition[], opts: BuildAiToolsOptions = {}): ToolSet {
  const maxRetries = opts.maxRetries ?? 1;
  const availableNames = new Set(defs.map((d) => d.name));
  const tools: ToolSet = {};

  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description || `MCP tool: ${def.name}`,
      // MCP inputSchema is already JSON Schema; jsonSchema() takes it as-is
      // without requiring a hand-written Zod schema per tool.
      inputSchema: jsonSchema(def.inputSchema as never),
      execute: async (input: unknown) =>
        executeMcpToolWithRetry(def.name, (input as Record<string, unknown>) ?? {}, { maxRetries, availableNames }),
    });
  }
  return tools;
}
