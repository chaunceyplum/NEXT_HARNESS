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
import { judgeRagResult, JUDGEABLE_RAG_TOOLS, shouldJudgeLiveResult, type RagJudgment } from './rag-judge';
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
 * TASK 7: Validation errors — 4xx responses that are NOT auth/permission
 * failures. These mean the arguments are wrong and retrying with the same
 * args will always fail. We still do the RAG grounding lookup (so the model
 * knows what went wrong), but we return the findings immediately as a rich
 * error object rather than burning a retry attempt on a call that cannot
 * succeed.
 *
 * Pattern: any 4xx status code that isn't already caught by
 * isNonRetryableError (401/403/forbidden/unauthorized/permission denied).
 */
const VALIDATION_ERROR_PATTERNS = [
  // A status code only counts at the start of the message (MCP's
  // `422: {...}` shape) or right after status/code/http/error — a bare
  // `\b400\b` also matched ids and durations like "timed out after 400 ms".
  // 400 Bad Request, 404 Not Found, 409 Conflict, 410 Gone, 422 Unprocessable.
  // 429 is deliberately absent: a rate limit is transient, not bad arguments.
  /(?:^\s*|\b(?:status|code|http|error)\W{0,3})(?:400|404|409|410|422)\b/i,
  /bad request/i,
  /not found/i,
  /unprocessable/i,
  /invalid.*field/i,
  /validation.*error/i,
  /constraint.*violation/i,
  /already exists/i,
  /duplicate/i,
];

export function isValidationError(message: string): boolean {
  if (isNonRetryableError(message)) return false; // auth errors take priority
  if (isRateLimitError(message)) return false;    // transient — retry instead
  return VALIDATION_ERROR_PATTERNS.some((re) => re.test(message));
}

const RATE_LIMIT_ERROR_PATTERNS = [
  /(?:^\s*|\b(?:status|code|http|error)\W{0,3})429\b/i,
  /too many requests/i,
  /rate.?limit/i,
];

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_ERROR_PATTERNS.some((re) => re.test(message));
}

/** Back-off before transient retry N (1-based): 500ms, 1s, 2s…; longer for rate limits. */
function retryDelayMs(attempt: number, message: string): number {
  const base = isRateLimitError(message) ? 2_000 : 500;
  return base * 2 ** (attempt - 1);
}

/**
 * A validation error whose text doesn't say what's wrong — just a status
 * line like `400: Bad Request` or `422 Unprocessable Entity`, with no field,
 * value, or constraint named. The model can't fix its arguments from that
 * alone, so this is one of the two cases where a knowledge-base lookup is
 * worth its cost (see shouldGroundValidationError).
 */
const GENERIC_ERROR_WORDS =
  /\b(?:http|status|code|error|errors?|bad|request|invalid|unprocessable|entity|content|not|found|conflict|gone|validation|failed|the|a)\b/gi;

export function isUninformativeError(message: string): boolean {
  const residue = message
    .replace(/\b\d{3}\b/g, ' ')
    .replace(GENERIC_ERROR_WORDS, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  // Anything left over (a field name, a value, a constraint) is something the model can act on.
  return residue.length < 3;
}

/**
 * Per-run state shared by every tool built by one buildAiTools() call (one
 * agent run): how often each tool has hit a validation error, and the
 * knowledge-base lookups already made, so the same failure isn't looked up
 * twice.
 */
export interface GroundingState {
  validationFailures: Map<string, number>;
  lookups: Map<string, Promise<unknown>>;
}

export function createGroundingState(): GroundingState {
  return { validationFailures: new Map(), lookups: new Map() };
}

/**
 * One knowledge-search's quality judgment, collected out-of-band. The judge
 * (rag-judge.ts) is monitoring data the agent never acts on, so it no longer
 * rides on the tool result the model sees — it's scored off the critical path
 * and lands here instead, to be persisted with the run record.
 */
export interface RagJudgmentEntry {
  toolName: string;
  query: string;
  judgment: RagJudgment;
}

/**
 * Per-run collector for RAG judgments produced by the fire-and-forget judge.
 *
 * A judgeable knowledge search kicks off judgeRagResult() WITHOUT awaiting it
 * (so the tool call returns to the agent immediately), and tracks the pending
 * promise here. drain() awaits every outstanding judgment and returns those
 * that produced a verdict — runAgent calls it once the loop finishes, so the
 * judgments are captured before the run resolves without ever sitting on a
 * tool call's critical path. One per buildAiTools() call, i.e. per agent run,
 * mirroring GroundingState.
 */
export interface RagJudgmentSink {
  /** Track a fire-and-forget judgment. Never rejects — a failed judge just contributes nothing. */
  track(promise: Promise<RagJudgmentEntry | undefined>): void;
  /** Await all tracked judgments and return the ones that produced a verdict. */
  drain(): Promise<RagJudgmentEntry[]>;
}

export function createRagJudgmentSink(): RagJudgmentSink {
  const pending: Promise<RagJudgmentEntry | undefined>[] = [];
  return {
    track(promise) {
      // Swallow rejections here so a judge failure can never surface as an
      // unhandled rejection; drain() filters the undefined out.
      pending.push(promise.catch(() => undefined));
    },
    async drain() {
      const settled = await Promise.all(pending);
      return settled.filter((e): e is RagJudgmentEntry => e !== undefined);
    },
  };
}

/**
 * Whether a validation error is worth a knowledge-base lookup. Most aren't:
 * the error itself usually names the bad field, and the model fixes it on
 * the next call. Look up only when the model is stuck — the same tool has
 * already failed validation earlier in this run — or the error gives it
 * nothing to go on.
 */
export function shouldGroundValidationError(priorFailures: number, message: string): 'repeat-failure' | 'uninformative-error' | undefined {
  if (priorFailures >= 1) return 'repeat-failure';
  if (isUninformativeError(message)) return 'uninformative-error';
  return undefined;
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
 * carried a `query` string, score a sample of results (see
 * shouldJudgeLiveResult — against the real, uncapped content; the judge has
 * its own separate size cap) and cap the
 * result itself before it's returned to the model. Judgment metadata rides
 * along on the capped result the same way `_retryHistory` rides along
 * below, so callers reading a result's normal fields are unaffected either
 * way. A non-object capped result (i.e. one large enough to have become a
 * truncated string) can't carry the judgment metadata too — the truncation
 * note matters more there than the judgment would.
 */
function withRagJudgment(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  sink?: RagJudgmentSink
): unknown {
  const capped = capRagResult(result);
  if (!JUDGEABLE_RAG_TOOLS.has(toolName)) return capped;
  const query = typeof args.query === 'string' ? args.query : undefined;
  if (!query || !shouldJudgeLiveResult(result)) return capped;

  // Fire-and-forget: kick off the judge on the UNCAPPED result (it has its
  // own size cap) WITHOUT awaiting, so the tool call returns to the agent
  // immediately instead of waiting a whole extra model round trip. It's
  // monitoring data the agent doesn't act on, so it no longer rides on the
  // result the model sees.
  //
  // judgeRagResult never rejects (it swallows model/credential failures and
  // resolves undefined — see rag-judge.ts), so this promise is safe to leave
  // untracked when no sink is attached. A sink, when present, collects the
  // verdict so runAgent can persist it with the run record.
  const judged = judgeRagResult(query, result).then((judgment) =>
    judgment ? { toolName, query, judgment } : undefined
  );
  sink?.track(judged);
  return capped;
}

export interface RetryAttemptRecord {
  attempt: number;
  error: string;
  raggedBefore?: {
    tool: string;
    query: string;
    /** Why this failure got a lookup at all — see shouldGroundValidationError. */
    reason: 'repeat-failure' | 'uninformative-error';
    findings?: unknown;
    lookupError?: string;
  };
}

export interface BuildAiToolsOptions {
  /** Extra attempts after a transient (5xx/timeout/429) failure, with back-off. 0 disables retrying. */
  maxRetries?: number;
  /**
   * Per-run collector for fire-and-forget RAG judgments. When provided,
   * judgeable knowledge searches are scored off the critical path and the
   * verdicts land here (see RagJudgmentSink). Omit to skip live judging.
   */
  ragJudgmentSink?: RagJudgmentSink;
}

export interface ExecuteMcpToolWithRetryOptions {
  /** Extra attempts after a transient (5xx/timeout/429) failure, with back-off. 0 disables retrying. */
  maxRetries: number;
  /** Names of tools in this run's selected set — used to pick a plausible grounding tool for the RAG lookup. */
  availableNames: Set<string>;
  /** Per-run lookup state (see GroundingState). A fresh one is used if omitted. */
  grounding?: GroundingState;
  /** Per-run RAG judgment collector (see RagJudgmentSink). Omit to skip live judging. */
  ragJudgmentSink?: RagJudgmentSink;
}

/**
 * Calls one MCP (or local) tool with the retry / knowledge-grounding
 * behavior, independent of the AI SDK tool wrapper below.
 *
 * Error handling has three tiers (TASK 7):
 *
 *   1. Auth/permission errors (401/403/forbidden/etc): throw immediately —
 *      no retry, no RAG lookup. These are permanent for this credential.
 *
 *   2. Validation errors (400/404/409/422/etc): the arguments are wrong and
 *      retrying the same call cannot fix that, so throw immediately. The AI
 *      SDK hands a thrown tool error back to the model as a tool-error
 *      result, so it sees the error and can correct its arguments, and the
 *      trace/evals still record it as a failure. A knowledge-base lookup is
 *      attached only when the model needs more than the error — see
 *      shouldGroundValidationError — and identical lookups in a run are
 *      made once.
 *
 *   3. Transient errors (5xx, timeouts, network, 429 rate limits): retry
 *      with exponential back-off. No lookup — documentation can't fix an
 *      outage or a rate limit.
 *
 * Retry history (including any lookup findings) rides along on the eventual
 * result/error so it's visible in the trace, not just to the model.
 *
 * RAG tools never go through this path — they call themselves once and return.
 */
export async function executeMcpToolWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  opts: ExecuteMcpToolWithRetryOptions
): Promise<unknown> {
  const { maxRetries, availableNames } = opts;
  const grounding = opts.grounding ?? createGroundingState();
  const isRagTool = RAG_TOOLS.has(toolName);

  if (isRagTool || maxRetries <= 0) {
    const result = await callTool(toolName, args);
    return isRagTool ? withRagJudgment(toolName, args, result, opts.ragJudgmentSink) : result;
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

      // Tier 1: permanent auth/permission error — fail immediately.
      if (isNonRetryableError(message)) {
        throw err;
      }

      // TASK 7 — Tier 2: validation error — arguments are wrong, retrying
      // the same call is pointless. Fail without retrying (see the tier list
      // above for why this throws), grounding it first only if needed.
      if (isValidationError(message)) {
        const priorFailures = grounding.validationFailures.get(toolName) ?? 0;
        grounding.validationFailures.set(toolName, priorFailures + 1);

        const record: RetryAttemptRecord = { attempt: attempt + 1, error: message };
        const reason = shouldGroundValidationError(priorFailures, message);
        const ragTool = reason ? pickRagTool(toolName, availableNames) : undefined;
        if (reason && ragTool) {
          const query = `Tool "${toolName}" failed with validation error: ${message}. Arguments used: ${summarizeArgsForRagQuery(args)}. What are the correct argument values or constraints?`;
          record.raggedBefore = { tool: ragTool, query, reason };
          try {
            // Keyed on tool + error, not the full query: the same rejection
            // with slightly different args needs the same docs.
            const key = `${ragTool}\u0000${toolName}\u0000${message}`;
            let lookup = grounding.lookups.get(key);
            if (!lookup) {
              lookup = callMcpTool(ragTool, { query });
              grounding.lookups.set(key, lookup);
              lookup.catch(() => grounding.lookups.delete(key)); // don't cache a failed lookup
            }
            record.raggedBefore.findings = summarizeFindingsForRetryHistory(await lookup);
          } catch (ragErr) {
            record.raggedBefore.lookupError = ragErr instanceof Error ? ragErr.message : String(ragErr);
          }
        }
        attempts.push(record);
        throw new Error(
          `${toolName} rejected its arguments (validation error — not retried; fix the arguments and call it again): ${message}\n` +
            `Retry history: ${JSON.stringify(attempts)}`
        );
      }

      // Tier 3: transient error — back off and retry.
      attempts.push({ attempt: attempt + 1, error: message });
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt + 1, message)));
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
 * Universal cap applied to every tool's result before it's returned to the
 * model. Prevents large list/read payloads from accumulating in context the
 * same way capRagResult() already does for knowledge-search results. This is
 * also what the trace and persisted run record see — there's no uncapped copy.
 *
 * 12 000 chars covers a large list_* response or a moderate read (e.g. a
 * CJA project definition) without truncating typical narrow-tool results
 * (create/update confirmation objects, short list pages) at all. The
 * truncation note tells the model to narrow its query rather than retry
 * blind.
 *
 * RAG results are already capped at 6 000 chars by capRagResult(), which
 * fires before this wrapper — the two caps don't conflict, this one is just
 * a backstop for every other tool.
 */
const MAX_CHARS_PER_TOOL_RESULT = 12_000;

export function capToolResult(toolName: string, result: unknown): unknown {
  // JSON.stringify returns undefined (not a string) for undefined/functions.
  const json = JSON.stringify(result);
  if (json === undefined || json.length <= MAX_CHARS_PER_TOOL_RESULT) return result;
  return (
    `${json.slice(0, MAX_CHARS_PER_TOOL_RESULT)}… (truncated — ${json.length} chars total. ` +
    `Use more specific arguments to ${toolName} to get a smaller, focused result.)`
  );
}

/**
 * Wrap a set of MCP tool definitions as an AI SDK ToolSet. Each tool's
 * `execute` calls straight through to executeMcpToolWithRetry — the model
 * only ever sees the schemas you hand it here, which is what makes
 * tool-shortlisting (lib/llm/tool-retrieval.ts) effective: pass a narrow
 * `defs` list and the model literally cannot call anything outside it.
 *
 * Every result is capped at MAX_CHARS_PER_TOOL_RESULT before being returned
 * to the model, so that large list/read payloads don't accumulate unbounded
 * in context across a multi-step run.
 */
export function buildAiTools(defs: McpToolDefinition[], opts: BuildAiToolsOptions = {}): ToolSet {
  const maxRetries = opts.maxRetries ?? 1;
  const availableNames = new Set(defs.map((d) => d.name));
  // One per buildAiTools() call, i.e. per agent run — shared by every tool in it.
  const grounding = createGroundingState();
  const tools: ToolSet = {};

  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description || `MCP tool: ${def.name}`,
      // MCP inputSchema is already JSON Schema; jsonSchema() takes it as-is
      // without requiring a hand-written Zod schema per tool.
      inputSchema: jsonSchema(def.inputSchema as never),
      execute: async (input: unknown) => {
        const result = await executeMcpToolWithRetry(
          def.name,
          (input as Record<string, unknown>) ?? {},
          { maxRetries, availableNames, grounding, ragJudgmentSink: opts.ragJudgmentSink }
        );
        return capToolResult(def.name, result);
      },
    });
  }
  return tools;
}
