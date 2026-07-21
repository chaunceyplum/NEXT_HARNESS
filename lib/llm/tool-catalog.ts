/**
 * MCP tool catalog + AI SDK tool adapter.
 *
 * Fetches the tool list from the MCP server once (tools/list), caches it in
 * memory for the life of the process, and can wrap any subset of it as an
 * AI SDK ToolSet backed by callMcpTool(). This is what lets the agent call
 * arbitrary MCP tools without us hand-writing a wrapper per tool.
 */

import { listMcpTools } from '@/lib/mcp-client';
import { runToolViaStepFunctions } from '@/lib/step-functions-client';
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
  stepFunctionExecutionArn?: string;
  raggedBefore?: {
    tool: string;
    query: string;
    findings?: unknown;
    lookupError?: string;
  };
}

/** Thrown when a tool call's Step Functions execution didn't succeed. Carries the executionArn so callers/UI can link to it. */
export class StepFunctionToolError extends Error {
  constructor(message: string, public executionArn: string) {
    super(message);
    this.name = 'StepFunctionToolError';
  }
}

/**
 * Every MCP tool *call* (as opposed to the one-time tools/list catalog fetch
 * above) runs as its own Step Functions execution of the tool-executor state
 * machine (infra/step-functions/) rather than a bare HTTP call — see that
 * directory's README for why. Successful results carry the executionArn
 * alongside the tool's own output so the UI can link to the execution.
 */
async function executeMcpTool(toolName: string, args: Record<string, unknown>, runId: string): Promise<unknown> {
  const outcome = await runToolViaStepFunctions(toolName, args, { runId });

  if (outcome.status === 'SUCCEEDED') {
    const output = outcome.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return { ...(output as Record<string, unknown>), _stepFunctionExecutionArn: outcome.executionArn };
    }
    return output;
  }

  const detail = [outcome.error, outcome.cause].filter(Boolean).join(': ');
  throw new StepFunctionToolError(
    `${toolName} failed via Step Functions execution ${outcome.executionArn} (${outcome.status}): ${detail || 'no error detail'}`,
    outcome.executionArn
  );
}

export interface BuildAiToolsOptions {
  /** Extra retries after the first failed attempt, each preceded by a RAG lookup. 0 disables retrying. */
  maxRetries?: number;
  /** Groups this run's tool-call executions together in Step Functions execution names. Required. */
  runId: string;
}

/**
 * Wrap a set of MCP tool definitions as an AI SDK ToolSet. Each tool's
 * `execute` calls straight through to the MCP server via callMcpTool — the
 * model only ever sees the schemas you hand it here, which is what makes
 * tool-shortlisting (lib/llm/tool-retrieval.ts) effective: pass a narrow
 * `defs` list and the model literally cannot call anything outside it.
 *
 * On failure, before retrying, this consults the relevant knowledge-search
 * tool (query built from the tool name, its arguments, and the error) so
 * the retry — and the model's own next move if the retry also fails — has
 * more to go on than "it errored." Retry history (including what the RAG
 * lookup found) rides along on the eventual result/error so it's visible
 * in the trace, not just to the model.
 */
export function buildAiTools(defs: McpToolDefinition[], opts: BuildAiToolsOptions): ToolSet {
  const maxRetries = opts.maxRetries ?? 1;
  const { runId } = opts;
  const availableNames = new Set(defs.map((d) => d.name));
  const tools: ToolSet = {};

  for (const def of defs) {
    const isRagTool = RAG_TOOLS.has(def.name);

    tools[def.name] = tool({
      description: def.description || `MCP tool: ${def.name}`,
      // MCP inputSchema is already JSON Schema; jsonSchema() takes it as-is
      // without requiring a hand-written Zod schema per tool.
      inputSchema: jsonSchema(def.inputSchema as never),
      execute: async (input: unknown) => {
        const args = (input as Record<string, unknown>) ?? {};

        // RAG tools call themselves — never retry-with-RAG-lookup those,
        // or a failing search would try to "ground itself" recursively.
        if (isRagTool || maxRetries <= 0) {
          return executeMcpTool(def.name, args, runId);
        }

        const attempts: RetryAttemptRecord[] = [];
        let lastError: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const result = await executeMcpTool(def.name, args, runId);
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
            const executionArn = err instanceof StepFunctionToolError ? err.executionArn : undefined;

            if (attempt < maxRetries) {
              const ragTool = pickRagTool(def.name, availableNames);
              const record: RetryAttemptRecord = { attempt: attempt + 1, error: message, stepFunctionExecutionArn: executionArn };
              if (ragTool) {
                const query = `Tool "${def.name}" failed with error: ${message}. Arguments used: ${JSON.stringify(args)}. What is the correct usage or known constraint here?`;
                record.raggedBefore = { tool: ragTool, query };
                try {
                  record.raggedBefore.findings = await executeMcpTool(ragTool, { query }, runId);
                } catch (ragErr) {
                  record.raggedBefore.lookupError = ragErr instanceof Error ? ragErr.message : String(ragErr);
                }
              }
              attempts.push(record);
            } else {
              attempts.push({ attempt: attempt + 1, error: message, stepFunctionExecutionArn: executionArn });
            }
          }
        }

        const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `${def.name} failed after ${attempts.length} attempt(s): ${finalMessage}\n` +
            `Retry history: ${JSON.stringify(attempts)}`
        );
      },
    });
  }
  return tools;
}
