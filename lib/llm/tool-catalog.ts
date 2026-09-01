/**
 * MCP tool catalog + AI SDK tool adapter.
 *
 * Fetches the tool list from the MCP server once (tools/list), merges in
 * the locally-defined tools (lib/llm/local-tools.ts — github_read_file/
 * github_list_directory, which call GitHub's API directly since the MCP
 * server has no read tool and isn't ours to modify), caches the combined
 * catalog in memory for the life of the process, and can wrap any subset
 * of it as an AI SDK ToolSet backed by executeMcpToolWithRetry(). This is
 * what lets the agent call arbitrary MCP (or local) tools without us
 * hand-writing a wrapper per tool.
 */

import { callMcpTool, listMcpTools } from '@/lib/mcp-client';
import { executeLocalTool, isLocalTool, LOCAL_TOOL_DEFINITIONS } from './local-tools';
import { validateBeforeCommit } from './commit-validation';
import { judgeRagResult, JUDGEABLE_RAG_TOOLS, type RagJudgment } from './rag-judge';
import { jsonSchema, tool, type ToolSet } from 'ai';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Non-Adobe integrations the harness currently has no use for. As of the
 * last live tools/list check (Aug 2026), the connected MCP server doesn't
 * actually expose any aws_/databricks_/snowflake_-prefixed tools or the
 * named search/pattern tools below — so today this filter is a no-op
 * defensive guard, not an active exclusion. It's kept (rather than deleted)
 * so that if a future server redeploy brings AWS/data-eng tools back into
 * the catalog, they stay excluded by default instead of silently competing
 * for shortlist slots against the Adobe tools every request here actually
 * needs — verify this list against a fresh tools/list before relying on it
 * to hide anything.
 *
 * Filtered out of the catalog entirely (not just excluded from the
 * shortlist) so this is enforced regardless of embedding/keyword scoring,
 * and so an always-on tool from one of these categories would silently
 * become unavailable too — agent.ts already does
 * `ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name))`.
 *
 * Set ADOBE_TOOLS_ONLY=false to disable this filter without a code change.
 */
const NON_ADOBE_TOOL_PREFIXES = ['aws_', 'databricks_', 'snowflake_'];
const NON_ADOBE_TOOL_NAMES = new Set([
  'search_aws_knowledge',
  'search_data_eng_knowledge',
  'search_braze_knowledge',
  'search_zeta_knowledge',
  'search_all_agents',
  'aws_architecture_pattern',
  'aws_recommend_services',
  'data_sql_pattern',
  'data_pipeline_pattern',
  'data_compare_platforms',
]);

function isAdobeToolsOnlyEnabled(): boolean {
  return process.env.ADOBE_TOOLS_ONLY !== 'false';
}

export function isAdobeScoped(name: string): boolean {
  if (NON_ADOBE_TOOL_NAMES.has(name)) return false;
  return !NON_ADOBE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
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
        const combined = [...(raw as McpToolDefinition[]), ...LOCAL_TOOL_DEFINITIONS];
        return isAdobeToolsOnlyEnabled() ? combined.filter((t) => isAdobeScoped(t.name)) : combined;
      })
      .catch((err) => {
        // Don't cache a failed fetch — next call should retry.
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

/** Local tools first (no network round-trip), then the MCP server — with the pre-commit syntax check gating msb_github_commit_code either way. */
async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (isLocalTool(toolName)) {
    return executeLocalTool(toolName, args);
  }
  await validateBeforeCommit(toolName, args);
  return callMcpTool(toolName, args);
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
 * themselves. Verified present in the live MCP catalog, Aug 2026.
 */
const RAG_TOOLS = new Set([
  'search_adobe_knowledge',
  'search_all_agents',
  'query_rag_db',
  'knowledge_base_health',
]);

/**
 * Permission/ownership errors are permanent for the credential this process
 * runs under — retrying, or consulting the knowledge base for "correct
 * usage," cannot change who owns a resource. Matched against the raw error
 * message since MCP surfaces the origin API's status code and error code
 * there (e.g. `403: {"errorCode":"insufficient_access",...}`).
 */
const NON_RETRYABLE_ERROR_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /insufficient_access/i,
  /forbidden/i,
  /unauthorized/i,
  /permission denied/i,
];

export function isNonRetryableError(message: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Tool arguments embedded in a RAG lookup query so it's bounded regardless
 * of payload size — e.g. a CJA project definition can be tens of KB, and
 * that has no bearing on searching docs for "what's the correct usage."
 * Without this cap, one large-payload tool call duplicates its entire
 * argument set across the query, the findings, and the retry history.
 */
const MAX_ARGS_CHARS_IN_RAG_QUERY = 600;

export function summarizeArgsForRagQuery(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  if (json.length <= MAX_ARGS_CHARS_IN_RAG_QUERY) return json;
  return `${json.slice(0, MAX_ARGS_CHARS_IN_RAG_QUERY)}… (truncated, ${json.length} chars total)`;
}

/**
 * A knowledge-search tool's own results, embedded into retry history and
 * (if all retries are exhausted) the final thrown error's "Retry history"
 * JSON blob — uncapped, a single grounding lookup can return tens of KB
 * (a real production run hit 48KB from one lookup), and that then rides
 * along in the model's context for every subsequent step of the run. Wider
 * than MAX_ARGS_CHARS_IN_RAG_QUERY since findings need to stay useful for
 * debugging, not just present.
 */
const MAX_FINDINGS_CHARS_IN_RETRY_HISTORY = 2000;

export function summarizeFindingsForRetryHistory(findings: unknown): unknown {
  const json = JSON.stringify(findings);
  if (json.length <= MAX_FINDINGS_CHARS_IN_RETRY_HISTORY) return findings;
  return `${json.slice(0, MAX_FINDINGS_CHARS_IN_RETRY_HISTORY)}… (truncated, ${json.length} chars total)`;
}

/**
 * Pick which knowledge base is most likely to explain a tool failure.
 * search_adobe_knowledge can't explain a GitHub API failure, so a failed
 * "github_" or "msb_github_" tool call gets no grounding lookup at all
 * rather than one that's irrelevant by construction — it was still firing
 * before this, uselessly inflating those tools' retry-history/error size
 * for no benefit.
 */
export function pickRagTool(toolName: string, available: Set<string>): string | undefined {
  if (toolName.startsWith('github_') || toolName.startsWith('msb_github_')) return undefined;
  if (available.has('search_adobe_knowledge')) return 'search_adobe_knowledge';
  return [...available].find((c) => RAG_TOOLS.has(c));
}

/**
 * A search_adobe_knowledge/search_all_agents call's own result, made
 * directly by the model (not the automatic retry-grounding path — see
 * summarizeFindingsForRetryHistory for that one) and returned straight to
 * it as the tool output. One real production run burned roughly 400K input
 * tokens largely because ~9 of these searches (2-4K tokens/~8-16K chars
 * each), made across a troubleshooting loop, each stayed in full in every
 * subsequent turn's context — the multi-step loop resends the whole
 * conversation so far on every turn. Capped generously enough to still
 * carry a complete explanatory answer for a genuine knowledge question
 * (e.g. "what's the best merge policy for..."), just not an unbounded one.
 * This is a backstop, not the primary fix for a troubleshooting loop —
 * that's the system prompt's "stop repeating the same failed approach"
 * rule (lib/llm/agent-core.ts).
 */
const MAX_CHARS_IN_RAG_RESULT = 6000;

export function capRagResult(result: unknown): unknown {
  const json = JSON.stringify(result);
  if (json.length <= MAX_CHARS_IN_RAG_RESULT) return result;
  return `${json.slice(0, MAX_CHARS_IN_RAG_RESULT)}… (truncated, ${json.length} chars total — narrow the query for a more focused result)`;
}

/**
 * If `toolName` is a judgeable RAG tool (see rag-judge.ts) and its args
 * carried a `query` string, score the result (against the real,
 * uncapped content — the judge has its own separate size cap) and cap the
 * result itself before it's returned to the model. Judgment metadata rides
 * along on the capped result the same way `_retryHistory` rides along
 * below, so callers reading a result's normal fields are unaffected either
 * way. A non-object capped result (i.e. one large enough to have become a
 * truncated string) can't carry the judgment metadata too — the truncation
 * note matters more there than the judgment would.
 */
async function withRagJudgment(toolName: string, args: Record<string, unknown>, result: unknown): Promise<unknown> {
  if (!JUDGEABLE_RAG_TOOLS.has(toolName)) return result;
  const query = typeof args.query === 'string' ? args.query : undefined;
  if (!query) return capRagResult(result);

  const judgment = await judgeRagResult(query, result);
  const capped = capRagResult(result);
  if (!judgment) return capped;
  if (capped && typeof capped === 'object' && !Array.isArray(capped)) {
    return { ...(capped as Record<string, unknown>), _ragJudgment: judgment };
  }
  return capped;
}

export interface RetryAttemptRecord {
  attempt: number;
  error: string;
  raggedBefore?: {
    tool: string;
    query: string;
    findings?: unknown;
    /** Set when the grounding lookup's own results were scored — see rag-judge.ts. */
    judgment?: RagJudgment;
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
 * independent of the AI SDK tool wrapper below.
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
    const result = await callTool(toolName, args);
    return isRagTool ? withRagJudgment(toolName, args, result) : result;
  }

  const attempts: RetryAttemptRecord[] = [];
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callTool(toolName, args);
      if (attempts.length === 0) return result;
      // Succeeded after retrying — attach retry history without
      // disturbing the shape callers rely on for reading fields directly
      // off a tool's result object.
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ...(result as Record<string, unknown>), _retryHistory: attempts };
      }
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      // Permanent for this credential — no retry, no RAG lookup, fail now.
      if (isNonRetryableError(message)) {
        throw err;
      }

      if (attempt < maxRetries) {
        const ragTool = pickRagTool(toolName, availableNames);
        const record: RetryAttemptRecord = { attempt: attempt + 1, error: message };
        if (ragTool) {
          const query = `Tool "${toolName}" failed with error: ${message}. Arguments used: ${summarizeArgsForRagQuery(args)}. What is the correct usage or known constraint here?`;
          record.raggedBefore = { tool: ragTool, query };
          try {
            const findings = await callMcpTool(ragTool, { query });
            // Judge against the real findings (still bounded on its own —
            // see rag-judge.ts's own cap), but only ever store/throw the
            // capped version below.
            record.raggedBefore.judgment = await judgeRagResult(query, findings);
            record.raggedBefore.findings = summarizeFindingsForRetryHistory(findings);
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
