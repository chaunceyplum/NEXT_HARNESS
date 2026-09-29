/**
 * The agent loop that replaces the old fixed pipeline.
 *
 * Runtime optimisations layered on top of the basic generateText loop:
 *
 *   1. Prompt caching (TASK 1): the system prompt is sent as a SystemModelMessage
 *      via `instructions` (AI SDK v7 rejects system messages inside `messages`)
 *      with providerOptions.anthropic.cacheControl so Anthropic
 *      and Bedrock cache it after the first step. Tool definitions are similarly
 *      cached via toolOrder stability (shortlist never shuffles). Cache-write on
 *      the first step, much-cheaper cache-read on every subsequent step.
 *
 *   2. Context management (TASK 2): tool results from older steps stop being
 *      resent at full size. Normally prepareStep swaps them for a one-line
 *      summary. Models that bind thinking to the exact prior conversation
 *      (see HISTORY_BOUND_MODEL_RE) reject any rewrite of earlier messages, so
 *      for those the API's server-side context editing clears them instead.
 *      The trace keeps the uncompressed results (each already capped at 12K
 *      chars by capToolResult) — only the in-flight model context shrinks.
 *
 *   3. Last-step summary (TASK 3): the final allowed step is steered to a
 *      written answer so the run doesn't end cut off mid-tool-call when
 *      stepCountIs fires. (So with maxSteps=1 the run is text-only.)
 *
 *   6. Tool discovery (TASK 6): the tool list the model sees is fixed for the
 *      whole run — the shortlist plus `find_tools` and `call_tool`. find_tools
 *      searches the rest of the (policy-filtered) catalog and returns schemas;
 *      call_tool runs any of those by name. Keeping the list fixed preserves
 *      the prompt cache and never trips the history-binding check above,
 *      which swapping tools in and out mid-run would.
 *
 *   9. Approval (TASK 9): destructive calls wait for a human decision via
 *      RunAgentOptions.approveTool; without an approver they're denied.
 */

import { streamText, stepCountIs, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai';
import { getDefaultModelKey, getModelRegistry, resolveModel, getModelEntry } from './model-registry';
import { buildAiTools, getMcpToolCatalog, createRagJudgmentSink, type RagJudgmentEntry, type RagJudgmentSink } from './tool-catalog';
import { buildDiscoveryTools, effectiveToolCall } from './tool-discovery';
import { shortlistTools } from './tool-retrieval';
import { ALWAYS_ON_TOOLS, systemPrompt, stage, type AgentStepTrace } from './agent-core';
import { classifyProviderFailure, defaultModelHealth, ModelHealthTracker } from './model-health';
import { applyToolPolicy, classifyTool, resolvePolicy, type PolicyMode } from './tool-policy';
import { applyActionGuards } from './guardrails';
import {
  budgetFinalNote,
  resolveBudget,
  RunBudgetTracker,
  type BudgetStopReason,
  type BudgetUsage,
  type RunBudgetLimits,
} from './run-budget';
import { approvalReason, APPROVAL_REASON_TEXT, resolveRolloutMode, type ApprovalReason, type RolloutMode } from './approval-policy';
import { RunTracer, exportSpans, type StepSample, type AttrValue } from '../tracing';
import { promptVersion, toolsetVersion, appVersion } from '../version';

export { ALWAYS_ON_TOOLS };
export type { AgentStepTrace };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentRunResult {
  finalText: string;
  steps: AgentStepTrace[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
  /** Model registry key that actually produced the result. Differs from the requested one after a same-tier fallback. */
  modelKey: string;
  /**
   * Set when a run budget or loop detection cut the run short (run-budget.ts).
   * The final text is then a wrap-up of partial work, not a finished answer.
   */
  stopReason?: BudgetStopReason;
  /** Tokens, estimated cost, and wall-clock time the successful attempt used. */
  budgetUsage: BudgetUsage;
  /**
   * Quality judgments for a sample of the knowledge searches this run made,
   * scored off the critical path by the fire-and-forget RAG judge
   * (lib/llm/rag-judge.ts) and drained once the loop finished. Monitoring
   * data the agent didn't act on — persisted with the run record. Empty when
   * nothing was sampled, judging is disabled, or the eval path was used.
   */
  ragJudgments: RagJudgmentEntry[];
  /**
   * Version fingerprints for this run (lib/version.ts), so a stored trace or
   * score can be tied to the exact prompt, tool set and build it came from.
   */
  versions: {
    /** sha256(system prompt), first 12 hex — matches the eval's promptVersion. */
    prompt: string;
    /** sha256(sorted tool name+description lines), first 12 hex. */
    toolset: string;
    /** GIT_SHA / APP_VERSION / package version, or 'dev'. */
    app: string;
  };
}

export interface RunAgentOptions {
  userInput: string;
  /**
   * Persisted run id (from the route). Recorded on the trace's run span as
   * `harness.run.id` so a trace can be correlated with the stored run and its
   * replay view. Omit (e.g. the eval path) and the trace still works.
   */
  runId?: string;
  /** Model registry key, e.g. "anthropic:haiku". Defaults to DEFAULT_MODEL env var. */
  modelKey?: string;
  /** Tool-call round trips before the loop is forced to stop. */
  maxSteps?: number;
  /** How many tools the semantic shortlist pulls in, on top of the always-on set. */
  toolShortlistSize?: number;
  /** Extra attempts after a transient (5xx/timeout/429) tool failure, with back-off. 0 disables retrying. */
  toolRetries?: number;
  /**
   * Health tracker used to route around models failing on provider-side access/auth/quota errors.
   * Defaults to the process-wide tracker; inject a fresh one in tests.
   */
  modelHealth?: ModelHealthTracker;
  /**
   * A pre-built tool set to hand the model instead of shortlisting from the live MCP catalog.
   * Used by the agent eval (evals/agent.eval.ts) to grade the real loop against scripted tools.
   * Not exposed via /api/build.
   */
  tools?: ToolSet;
  /**
   * TASK 8 (streaming): called after each agent step completes with the
   * partial trace for that step. Allows the route to stream step events to
   * the client as they arrive rather than waiting for the full run to finish.
   */
  onStep?: (step: AgentStepTrace) => void;
  /**
   * TASK 1 (token streaming): called with each chunk of assistant text as the
   * model generates it, so the route can stream the answer to the client token
   * by token instead of only revealing it once the step finishes. The concrete
   * win is the final written answer rendering as it's produced; intermediate
   * steps are usually short text plus a tool call. Reasoning/thinking tokens
   * are NOT forwarded here (they're hidden by default on current models). Text
   * for a given step is also still delivered in full via onStep.
   */
  onTextDelta?: (delta: string) => void;
  /**
   * TASK 9: Tool policy to apply before handing the tool set to the model.
   * 'read-only' removes all write and destructive tools structurally —
   * the model cannot call them at all, not just rule-based.
   * Can only tighten BUILD_POLICY: BUILD_POLICY=read-only wins over 'full' here.
   */
  policy?: PolicyMode;
  /**
   * TASK 9: When true, wraps destructive tools to return a dry-run description
   * instead of executing. Can only tighten TOOL_DRY_RUN: false here does not
   * override TOOL_DRY_RUN=true.
   */
  dryRun?: boolean;
  /**
   * Rollout stage (approval-policy.ts): 'assisted' asks before every write,
   * 'shadow' dry-runs every write. Can only tighten ROLLOUT_MODE.
   */
  rolloutMode?: RolloutMode;
  /**
   * TASK 10: Enable extended thinking (Claude via Anthropic / Bedrock only).
   * Ignored for other providers and non-Claude Bedrock models.
   *
   * Minimum 1 024 tokens. On Haiku 4.5 and older Claude models this is the
   * thinking token budget (8 000–16 000 is a good start for multi-step
   * tasks). Newer models (Sonnet 5, Opus 4.7+, Opus 5.x) reject fixed budgets,
   * so there it just switches on adaptive thinking and the value is unused.
   *
   * Can also be set globally via THINKING_BUDGET_TOKENS env var (number).
   * Per-request value takes precedence over the env var.
   */
  thinkingBudget?: number;
  /** Per-request run limits (tokens, cost, time, identical calls). Can only tighten the RUN_* env limits. */
  budget?: Partial<RunBudgetLimits>;
  /** Aborts the run (model calls and the step loop) — wired to the client disconnecting / hitting Stop. */
  abortSignal?: AbortSignal;
  /**
   * Called when a provider failure makes the run restart from scratch on a
   * same-tier fallback model. Steps already reported via onStep belong to the
   * abandoned attempt and should be discarded.
   */
  onRestart?: (info: { fromModelKey: string; toModelKey: string }) => void;
  /**
   * TASK 9: asks a human to approve one tool call before it runs — every call
   * approval-policy.ts flags: destructive tools, non-read-only SQL, outbound
   * tools (commits, exports, destinations, publishing), credential reads, and
   * every write in assisted mode. Calls routed via call_tool are unwrapped
   * first. Calls that won't execute (dry-run/shadow) aren't gated. On a live
   * run without an approver, flagged calls are denied. The eval path
   * (opts.tools) is never gated.
   */
  approveTool?: (call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    reason: ApprovalReason;
  }) => Promise<{ approved: boolean; reason?: string }>;
}

// ── TASK 1: Prompt caching ────────────────────────────────────────────────────

/**
 * Cache markers for the system message, so the system prompt is cached after
 * the first call. The AI SDK's `toolOrder` stability (tools are never
 * shuffled) means tool definitions are also cache-eligible without per-tool
 * markup. Anthropic reads `cacheControl`; @ai-sdk/amazon-bedrock reads
 * `cachePoint` (and ignores cacheControl), and only Claude models on Bedrock
 * support it.
 */
function buildSystemMessage(modelKey: string, toolDiscovery: boolean): SystemModelMessage {
  const entry = tryGetModelEntry(modelKey);
  const providerOptions: SystemModelMessage['providerOptions'] =
    entry?.provider === 'anthropic'
      ? { anthropic: { cacheControl: { type: 'ephemeral' } } }
      : entry?.provider === 'bedrock' && isClaudeModelId(entry.modelId)
        ? { bedrock: { cachePoint: { type: 'default' } } }
        : undefined;
  return { role: 'system', content: systemPrompt({ toolDiscovery }), ...(providerOptions ? { providerOptions } : {}) };
}

function tryGetModelEntry(modelKey: string) {
  try { return getModelEntry(modelKey); } catch { return undefined; }
}

function isClaudeModelId(modelId: string): boolean {
  return /claude/i.test(modelId);
}

// ── Conversation-bound thinking ───────────────────────────────────────────────

/**
 * Claude models that bind their thinking blocks to the exact prior
 * conversation — system prompt, tools array, and every earlier message must
 * be byte-identical when the blocks are replayed, or the API returns a 400
 * (enforced by default for accounts created on or after 2026-08-31). These
 * always think, so on them the loop must be append-only: no rewriting old
 * tool results, no dropping the tools array for a text-only last step.
 */
const HISTORY_BOUND_MODEL_RE = /claude-(?:opus-5-5|fable-5-1|mythos-5-1)/i;

function isHistoryBound(modelKey: string): boolean {
  const entry = tryGetModelEntry(modelKey);
  return Boolean(entry && HISTORY_BOUND_MODEL_RE.test(entry.modelId));
}

/** Server-side clearing of old tool results starts once a request's input passes this many tokens. */
const CONTEXT_EDIT_TRIGGER_TOKENS = 30_000;
/** Most recent tool uses kept intact by server-side context editing. */
const CONTEXT_EDIT_KEEP_TOOL_USES = 3;

/**
 * Server-side context editing (clear_tool_uses) — the API clears old tool
 * results itself, which doesn't count as a history edit. Anthropic takes
 * the typed `contextManagement` option; on Bedrock it's passed through as a
 * raw request field plus its beta flag.
 */
function contextEditingProviderOptions(modelKey: string): ProviderOptions | undefined {
  const entry = tryGetModelEntry(modelKey);
  if (!entry || !isClaudeModelId(entry.modelId)) return undefined;
  const trigger = { type: 'input_tokens', value: CONTEXT_EDIT_TRIGGER_TOKENS };
  const keep = { type: 'tool_uses', value: CONTEXT_EDIT_KEEP_TOOL_USES };
  // find_tools results carry the schemas call_tool needs — keep them.
  const excluded = ['find_tools'];
  if (entry.provider === 'anthropic') {
    return {
      anthropic: {
        contextManagement: { edits: [{ type: 'clear_tool_uses_20250919', trigger, keep, excludeTools: excluded }] },
      },
    };
  }
  if (entry.provider === 'bedrock') {
    return {
      bedrock: {
        anthropicBeta: ['context-management-2025-06-27'],
        additionalModelRequestFields: {
          context_management: { edits: [{ type: 'clear_tool_uses_20250919', trigger, keep, exclude_tools: excluded }] },
        },
      },
    };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, unknown>>;

/** Merge per-provider option objects (one level deep — provider key, then option). */
function mergeProviderOptions(...parts: Array<ProviderOptions | undefined>): ProviderOptions | undefined {
  const merged: ProviderOptions = {};
  for (const part of parts) {
    for (const [provider, options] of Object.entries(part ?? {})) {
      merged[provider] = { ...merged[provider], ...options };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** How far past the time budget a run may go (to finish the step in flight and wrap up) before it's aborted. */
const HARD_TIMEOUT_GRACE_MS = 5 * 60_000;

/** Appended on the final step for history-bound models, which can't drop the tools array. */
const FINAL_STEP_NOTE =
  'This is your last step: do not call any more tools. Write your final answer now, based on what you have done so far.';

// ── TASK 10: Extended thinking ────────────────────────────────────────────────

/** Minimum token budget Anthropic accepts for budget-based extended thinking. */
const THINKING_MIN_TOKENS = 1_024;

/**
 * Claude models that still take `{type: 'enabled', budgetTokens}`: Haiku 4.5
 * and older (Claude 3.x, Sonnet/Opus 4.0–4.5). Everything newer uses adaptive
 * thinking — Sonnet 5, Opus 4.7/4.8 and Opus 5/5.5 reject budgetTokens with a
 * 400 — so on those the budget only switches thinking on and the model sizes
 * it itself.
 */
const BUDGET_THINKING_MODEL_RE =
  /claude-3|claude-(?:haiku|sonnet|opus)-4-[0-5](?:\b|[-.:])|claude-(?:sonnet|opus)-4-\d{8}/i;

/**
 * Resolve the providerOptions that enable extended thinking for this run, or
 * undefined when it's off. Per-request budget takes precedence over the
 * THINKING_BUDGET_TOKENS env var. Only Claude models (Anthropic direct, or
 * Claude on Bedrock) are eligible.
 */
function resolveThinkingProviderOptions(
  modelKey: string,
  perRequestBudget?: number
): ProviderOptions | undefined {
  const entry = tryGetModelEntry(modelKey);
  if (!entry || !isClaudeModelId(entry.modelId)) return undefined;
  if (entry.provider !== 'anthropic' && entry.provider !== 'bedrock') return undefined;

  const budget =
    perRequestBudget ??
    (process.env.THINKING_BUDGET_TOKENS ? parseInt(process.env.THINKING_BUDGET_TOKENS, 10) : undefined);
  if (!budget || isNaN(budget) || budget < THINKING_MIN_TOKENS) return undefined;

  const config = BUDGET_THINKING_MODEL_RE.test(entry.modelId)
    ? { type: 'enabled', budgetTokens: budget }
    : { type: 'adaptive' };
  // Anthropic takes `thinking`; @ai-sdk/amazon-bedrock takes `reasoningConfig`.
  return entry.provider === 'anthropic'
    ? { anthropic: { thinking: config } }
    : { bedrock: { reasoningConfig: config } };
}

// ── TASK 2: prepareStep context compression ───────────────────────────────────

/**
 * Steps older than this threshold have their tool results compressed to a
 * one-line summary. The current step and the one before it are kept at full
 * fidelity so the model can reason about what it just did.
 */
const RESULT_SUMMARY_THRESHOLD = 2;

/**
 * Compress tool results in the conversation history for steps older than
 * RESULT_SUMMARY_THRESHOLD. Large list/read payloads otherwise accumulate at
 * full size in the context that's resent on every turn (the same mechanism
 * behind the documented 400K-token run). The trace keeps each result as the
 * tool returned it (after capToolResult's 12K cap) — only the model's
 * in-flight context is shrunk further.
 *
 * Returns a new messages array if anything was compressed, or undefined to
 * leave the messages untouched (so we only override when it actually helps).
 *
 * Strategy: tool messages appear in call order. We keep the tool results from
 * the most recent RESULT_SUMMARY_THRESHOLD tool messages at full fidelity and
 * summarise the text/JSON output of older ones. Only outputs above a size
 * floor are touched, so small confirmation objects are left alone.
 */
const COMPRESS_FLOOR_CHARS = 500;

function compressOldToolMessages(
  messages: readonly ModelMessage[],
  completedSteps: number
): ModelMessage[] | undefined {
  if (completedSteps < RESULT_SUMMARY_THRESHOLD) return undefined;

  // Index of tool messages so we can keep the last N intact.
  const toolMsgIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolMsgIndexes.push(i);
  });
  if (toolMsgIndexes.length <= RESULT_SUMMARY_THRESHOLD) return undefined;

  const keepFrom = toolMsgIndexes[toolMsgIndexes.length - RESULT_SUMMARY_THRESHOLD];
  let changed = false;

  const rewritten = messages.map((m, i) => {
    if (m.role !== 'tool' || i >= keepFrom) return m;
    if (!Array.isArray(m.content)) return m;

    const newContent = m.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const out = part.output as { type?: string; value?: unknown };
      if (!out || (out.type !== 'text' && out.type !== 'json')) return part;

      const serialized = out.type === 'text' ? String(out.value) : JSON.stringify(out.value);
      if (serialized.length <= COMPRESS_FLOOR_CHARS) return part;

      changed = true;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: `[compressed to save context] ${part.toolName} returned ${serialized.length} chars. ${summariseOutputHint(out.type === 'json' ? out.value : serialized)}`,
        },
      };
    });

    return { ...m, content: newContent };
  });

  return changed ? (rewritten as ModelMessage[]) : undefined;
}

/** One-line hint about a compressed output so the model still has a signal. */
function summariseOutputHint(output: unknown): string {
  if (Array.isArray(output)) {
    return `Result was a list of ${output.length} item(s) — call the tool again with narrower arguments to re-fetch specific entries.`;
  }
  if (output && typeof output === 'object') {
    const keys = Object.keys(output as object);
    return `Result was an object with keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? `, …+${keys.length - 8}` : ''}. Re-fetch if you need the full content.`;
  }
  return 'Re-fetch with narrower arguments if you need the full content.';
}

// ── Tool selection ────────────────────────────────────────────────────────────

interface LiveToolSelection {
  /** What the model sees all run: always-on + shortlist + policy_info + find_tools + call_tool. */
  tools: ToolSet;
  /** Always-on tools plus the semantic shortlist (the directly-visible catalog tools). */
  toolsConsidered: string[];
}

async function selectLiveTools(
  userInput: string,
  toolShortlistSize: number,
  toolRetries: number,
  policy: { mode?: PolicyMode; dryRun?: boolean; dryRunWrites?: boolean },
  ragJudgmentSink: RagJudgmentSink
): Promise<LiveToolSelection> {
  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(userInput, { k: toolShortlistSize, exclude: alwaysOn })
  );

  // TASK 9: the policy runs over the whole catalog, so a tool reached via
  // call_tool is filtered/dry-run-wrapped exactly like a shortlisted one.
  // Action guardrails (write cap, protected ids, result redaction) wrap the
  // same objects call_tool executes.
  const callable = applyActionGuards(
    applyToolPolicy(buildAiTools(catalog, { maxRetries: toolRetries, ragJudgmentSink }), policy)
  );

  const toolsConsidered = [...new Set([...alwaysOn, ...shortlisted])].filter((name) => name in callable);
  const tools: ToolSet = Object.fromEntries(
    [...toolsConsidered, 'policy_info'].map((name) => [name, callable[name]])
  );
  // TASK 6: discovery over everything the policy allows (see tool-discovery.ts)
  Object.assign(tools, buildDiscoveryTools(catalog, callable, new Set(toolsConsidered)));

  return { tools, toolsConsidered };
}

// ── Step trace ────────────────────────────────────────────────────────────────

/**
 * Build a tracing StepSample from a live SDK step and hand it to the tracer.
 * Pulls tokens/timing from step.usage / step.performance and per-tool call
 * data (name, input, output/error, duration) from step.content, keyed to
 * step.performance.toolExecutionMs by tool call id. Provider/model id come
 * from the registry entry for the model that actually ran the step.
 */
function recordStepSpan(
  tracer: RunTracer,
  step: {
    text: string;
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    };
    content: ReadonlyArray<{ type: string }>;
    performance?: { stepTimeMs?: number; responseTimeMs?: number; toolExecutionMs?: Readonly<Record<string, number>> };
  },
  stepNumber: number,
  modelKey: string
): void {
  const entry = tryGetModelEntry(modelKey);
  const toolMs = step.performance?.toolExecutionMs ?? {};

  type Part = { type: string; toolName?: string; toolCallId?: string; input?: unknown; output?: unknown; result?: unknown; error?: unknown };
  // Pair each tool-call with its result/error part by call id.
  const byId = new Map<string, StepSample['tools'][number]>();
  const order: string[] = [];
  for (const p of step.content as ReadonlyArray<Part>) {
    if (!p.toolCallId || !p.toolName) continue;
    if (p.type === 'tool-call') {
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, { callId: p.toolCallId, toolName: p.toolName, input: p.input, durationMs: toolMs[p.toolCallId] });
    } else if (p.type === 'tool-result') {
      const t = byId.get(p.toolCallId) ?? { callId: p.toolCallId, toolName: p.toolName, input: undefined, durationMs: toolMs[p.toolCallId] };
      t.output = p.output ?? p.result;
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, t);
    } else if (p.type === 'tool-error') {
      const t = byId.get(p.toolCallId) ?? { callId: p.toolCallId, toolName: p.toolName, input: undefined, durationMs: toolMs[p.toolCallId] };
      t.error = p.error instanceof Error ? p.error.message : String(p.error);
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, t);
    }
  }

  const sample: StepSample = {
    stepNumber,
    modelId: entry?.modelId ?? modelKey,
    provider: entry?.provider ?? 'unknown',
    text: step.text,
    finishReason: step.finishReason ?? '',
    usage: {
      inputTokens: step.usage?.inputTokens,
      outputTokens: step.usage?.outputTokens,
      cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: step.usage?.inputTokenDetails?.cacheWriteTokens,
    },
    stepTimeMs: step.performance?.stepTimeMs ?? 0,
    responseTimeMs: step.performance?.responseTimeMs ?? 0,
    tools: order.map((id) => byId.get(id)!),
  };
  tracer.recordStep(sample);
}

/** Per-step data the AI SDK reports; only the fields the trace reads. */
interface StepForTrace {
  text: string;
  content: ReadonlyArray<{ type: string }>;
  /** step.usage — chat-model tokens for this step. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** step.performance — timing the SDK measured for this step (streaming steps only for some fields). */
  performance?: { stepTimeMs?: number; responseTimeMs?: number; toolExecutionMs?: Readonly<Record<string, number>> };
}

/**
 * Walk step.content directly — tool-error parts are NOT in step.toolResults
 * but we want them visible in the trace.
 *
 * When the live SDK step is passed (it carries `usage`/`performance`), the
 * trace is enriched with per-step timing/tokens and per-tool durations
 * (step.performance.toolExecutionMs, keyed by tool call id). Re-mapping stored
 * result steps (no performance) just omits those fields.
 */
function toStepTrace(step: StepForTrace, stepNumber: number): AgentStepTrace {
  const toolCalls: AgentStepTrace['toolCalls'] = [];
  const toolResults: AgentStepTrace['toolResults'] = [];
  const toolMs = step.performance?.toolExecutionMs;

  type Part = {
    type: string;
    toolName: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    result?: unknown;
    error?: unknown;
    approved?: boolean;
    reason?: string;
    toolCall?: { toolName: string };
  };
  for (const part of step.content as ReadonlyArray<Part>) {
    const durationMs = part.toolCallId ? toolMs?.[part.toolCallId] : undefined;
    if (part.type === 'tool-approval-response' && part.approved === false && part.toolCall) {
      // Denied calls never produce a tool-result/tool-error part.
      toolResults.push({ toolName: part.toolCall.toolName, output: undefined, error: `Not executed: ${part.reason ?? 'denied'}` });
    } else if (part.type === 'tool-call') {
      toolCalls.push({ toolName: part.toolName, input: part.input });
    } else if (part.type === 'tool-result') {
      // StaticToolResult uses .output; DynamicToolResult uses .result
      toolResults.push({ toolName: part.toolName, output: part.output ?? part.result, ...(durationMs !== undefined ? { durationMs } : {}) });
    } else if (part.type === 'tool-error') {
      const errVal = part.error;
      toolResults.push({
        toolName: part.toolName,
        output: undefined,
        error: errVal instanceof Error ? errVal.message : String(errVal),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  }

  const perf = step.performance;
  return {
    stepNumber,
    text: step.text,
    toolCalls,
    toolResults,
    ...(perf?.stepTimeMs !== undefined ? { durationMs: perf.stepTimeMs } : {}),
    ...(perf?.responseTimeMs !== undefined ? { modelMs: perf.responseTimeMs } : {}),
    ...(step.usage
      ? { usage: { inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens, totalTokens: step.usage.totalTokens } }
      : {}),
  };
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const {
    userInput,
    modelKey,
    maxSteps = 20,
    toolShortlistSize = 24,
    toolRetries = 1,
    modelHealth = defaultModelHealth,
  } = opts;

  let tools: ToolSet;
  let toolsConsidered: string[];
  const rolloutMode = resolveRolloutMode(opts.rolloutMode);
  // Collects fire-and-forget RAG judgments for live runs; drained once the
  // loop finishes. The eval path (opts.tools) doesn't judge, so it keeps no
  // sink — there's nothing to drain and no judgments to persist there.
  let ragJudgmentSink: RagJudgmentSink | undefined;

  if (opts.tools) {
    // Evals pass opts.tools and bypass the tool policy so scripted tool
    // fixtures aren't accidentally filtered.
    tools = opts.tools;
    toolsConsidered = Object.keys(opts.tools);
  } else {
    ragJudgmentSink = createRagJudgmentSink();
    const live = await selectLiveTools(
      userInput,
      toolShortlistSize,
      toolRetries,
      { mode: opts.policy, dryRun: opts.dryRun, dryRunWrites: rolloutMode === 'shadow' },
      ragJudgmentSink
    );
    tools = live.tools;
    toolsConsidered = live.toolsConsidered;
  }

  // TASK 9: gate risky calls on a human decision (live runs only).
  const { dryRun } = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const toolApproval = opts.tools
    ? undefined
    : async ({ toolCall }: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => {
        const call = effectiveToolCall(toolCall.toolName, toolCall.input);
        const reason = approvalReason(call.toolName, call.input, { mode: rolloutMode, dryRun });
        if (!reason) return 'not-applicable' as const;
        if (!opts.approveTool) {
          return {
            type: 'denied' as const,
            reason: `This call needs a human approver (${APPROVAL_REASON_TEXT[reason]}), and none is attached to this run.`,
          };
        }
        const decision = await opts.approveTool({ toolCallId: toolCall.toolCallId, ...call, reason });
        return { type: decision.approved ? ('approved' as const) : ('denied' as const), reason: decision.reason };
      };

  // Version fingerprints for this run (lib/version.ts). promptVersion matches
  // how the prompt is actually built: live runs include the find_tools rule.
  const toolDiscovery = 'find_tools' in tools;
  const versions = {
    prompt: promptVersion({ toolDiscovery }),
    toolset: toolsetVersion(
      Object.entries(tools).map(([name, t]) => ({ name, description: (t as { description?: string }).description }))
    ),
    app: appVersion(),
  };

  // ── Tracing (item #8) ──────────────────────────────────────────────────────
  // A fresh tracer per model attempt so a same-tier fallback's abandoned steps
  // don't leak into the exported trace (they get their own tracer, never
  // finished). `tracer` always points at the current attempt; finish() +
  // exportSpans() run once the loop settles, on both success and error.
  // Tracing reads only what the SDK already reports per step, so it never
  // changes the agent's behaviour, and export is best-effort (never throws).
  const baseTracerAttrs: Record<string, AttrValue> = {
    'harness.prompt.version': versions.prompt,
    'harness.toolset.version': versions.toolset,
    'harness.app.version': versions.app,
    ...(opts.runId ? { 'harness.run.id': opts.runId } : {}),
  };
  let tracer = new RunTracer(baseTracerAttrs);

  const isPinned = Boolean(modelKey);
  const registry = getModelRegistry();

  // TASK 8: step counter for onStepEnd → onStep mapping. Reset per model
  // attempt, since a fallback restarts the run from scratch.
  let stepIndex = 0;
  const runStartedAt = Date.now();
  const budgetLimits = resolveBudget(opts.budget);
  // Per model attempt, like stepIndex (a fallback restarts the run).
  let budget = new RunBudgetTracker(budgetLimits, modelKey || getDefaultModelKey(), runStartedAt);
  let stopReason: BudgetStopReason | undefined;
  // Whether the current attempt has executed a write/destructive tool call —
  // if so, falling back would re-run those side effects on the next model.
  let attemptHadSideEffects = false;

  const callModel = (resolvedModelKey: string) => {
    stepIndex = 0;
    attemptHadSideEffects = false;
    budget = new RunBudgetTracker(budgetLimits, resolvedModelKey, runStartedAt);
    stopReason = undefined;
    // Fresh tracer for this attempt (a fallback restarts the run from scratch).
    tracer = new RunTracer({ ...baseTracerAttrs, 'gen_ai.request.model': resolvedModelKey });
    // Step index at which a budget forced the wrap-up step; the loop stops after it.
    let forcedAt: number | undefined;

    // TASK 10: resolve thinking config for this model + request combination
    const thinkingProviderOptions = resolveThinkingProviderOptions(resolvedModelKey, opts.thinkingBudget);
    if (thinkingProviderOptions) {
      console.log(`[agent] extended thinking enabled (${resolvedModelKey}): ${JSON.stringify(thinkingProviderOptions)}`);
    }
    const historyBound = isHistoryBound(resolvedModelKey);
    const providerOptions = mergeProviderOptions(
      thinkingProviderOptions,
      historyBound ? contextEditingProviderOptions(resolvedModelKey) : undefined
    ) as Record<string, Record<string, never>> | undefined;

    return stage(`chat model call (${resolvedModelKey})`, async () => {
      // TASK 1 (token streaming): streamText instead of generateText so the
      // assistant's text is emitted as it's produced. Everything else — the
      // multi-step loop (stopWhen), prepareStep context management, the
      // approval gate, abort, thinking/context-editing providerOptions, and
      // the onStepEnd trace/side-effect tracking — is unchanged; streamText
      // takes the same options. We consume fullStream to forward text deltas,
      // then await the terminal promises for the same result shape the
      // fallback loop and result construction below already expect.
      const stream = streamText({
        model: resolveModel(resolvedModelKey),
        // TASK 1: system prompt with provider-specific cache markers
        instructions: buildSystemMessage(resolvedModelKey, 'find_tools' in tools),
        messages: [{ role: 'user', content: userInput }],
        tools,
        stopWhen: [stepCountIs(maxSteps), ({ steps }) => forcedAt !== undefined && steps.length > forcedAt],
        abortSignal: opts.abortSignal,
        // Hard backstop for the time budget, which is otherwise checked
        // between steps: one step that hangs (or waits on an approval) past
        // it still gets cut off, with room left for the wrap-up step.
        ...(budgetLimits.maxDurationMs !== undefined
          ? { timeout: { totalMs: budgetLimits.maxDurationMs + HARD_TIMEOUT_GRACE_MS - (Date.now() - runStartedAt) } }
          : {}),
        // TASK 10 (thinking) + TASK 2 (server-side context editing)
        ...(providerOptions ? { providerOptions } : {}),
        ...(toolApproval ? { toolApproval } : {}),
        prepareStep: ({ steps, messages }) => {
          // Run budgets / loop detection (run-budget.ts): a hit limit turns
          // this step into the wrap-up step, and repeated calls get a warning.
          const exceeded = budget.exceeded();
          if (exceeded && forcedAt === undefined) {
            forcedAt = steps.length;
            stopReason = exceeded;
          }
          const isLastStep = steps.length >= maxSteps - 1 || forcedAt !== undefined;
          const notes = budget.takeWarnings();
          if (exceeded) notes.push(budgetFinalNote(exceeded));
          else if (historyBound && isLastStep) notes.push(FINAL_STEP_NOTE);
          const withNotes = (base: ModelMessage[]): ModelMessage[] =>
            notes.length ? [...base, { role: 'user' as const, content: notes.join('\n\n') }] : base;

          // History-bound models: append-only. Old tool results are cleared
          // server-side (providerOptions above), and the last step keeps the
          // tools array — toolChoice 'none' makes the providers drop it — and
          // instead appends an instruction after the latest tool results.
          if (historyBound) {
            return notes.length ? { messages: withNotes(messages) } : {};
          }

          // TASK 2: compress tool results from steps older than the threshold
          // so large list/read payloads don't accumulate at full size in the
          // context that's resent on every turn. The trace (onStep /
          // result.steps) keeps the uncompressed (12K-capped) results; only
          // the in-flight model context is shrunk. Only compress when there's enough history
          // to be worth it — the most recent RESULT_SUMMARY_THRESHOLD steps
          // stay at full fidelity.
          const compressedMessages = compressOldToolMessages(messages, steps.length);

          // TASK 3: force text-only on the final allowed step
          const nextMessages = notes.length ? withNotes(compressedMessages ?? messages) : compressedMessages;
          return {
            toolChoice: isLastStep ? 'none' : 'auto',
            ...(nextMessages ? { messages: nextMessages } : {}),
          };
        },
        // TASK 8: fire onStep callback after each step so the route can stream it
        onStepEnd: (step) => {
          const stepNumber = stepIndex++;
          const trace = toStepTrace(step, stepNumber);
          budget.recordStep(
            step.usage,
            step.toolCalls.map((c) => effectiveToolCall(c.toolName, c.input))
          );
          // Only calls that actually ran count — a denied call never executed.
          for (const part of step.content) {
            if (part.type !== 'tool-result' && part.type !== 'tool-error') continue;
            if (classifyTool(effectiveToolCall(part.toolName, part.input).toolName) !== 'read') attemptHadSideEffects = true;
          }
          // Item #8: record a trace span for this step from what the SDK reports.
          recordStepSpan(tracer, step, stepNumber, resolvedModelKey);
          opts.onStep?.(trace);
        },
      });

      // Drain the stream, forwarding assistant text as it arrives. Reasoning
      // (thinking) deltas are intentionally not forwarded — they're hidden by
      // default on current models. Errors during streaming surface when the
      // terminal promises below are awaited, so they still reach the fallback
      // try/catch as a rejection rather than being swallowed here.
      if (opts.onTextDelta) {
        for await (const part of stream.fullStream) {
          if (part.type === 'text-delta') opts.onTextDelta(part.text);
        }
      }

      // Same shape generateText returned, so nothing downstream changes.
      // Awaiting these also drives the loop to completion when onTextDelta
      // isn't set (no fullStream consumer) and rejects on a provider failure.
      const [text, steps, finishReason, usage] = await Promise.all([
        stream.text,
        stream.steps,
        stream.finishReason,
        stream.usage,
      ]);
      return { text, steps, finishReason, usage };
    });
  };

  let resolvedModelKey = modelKey || getDefaultModelKey();
  if (!isPinned && modelHealth.isUnhealthy(resolvedModelKey)) {
    const healthy = modelHealth.pickFallback(resolvedModelKey, registry);
    if (healthy) resolvedModelKey = healthy;
  }

  // Finish the current attempt's trace and export it (best-effort). Called once
  // the run settles — on success with the run's totals, on failure with the
  // error. exportSpans never throws, so this can't disturb the run.
  const finishTrace = (extra: { attributes?: Record<string, AttrValue>; error?: string }): void => {
    try {
      const spans = tracer.finish({
        attributes: {
          'harness.model.key': resolvedModelKey,
          'harness.step.count': stepIndex,
          ...extra.attributes,
        },
        ...(extra.error ? { error: extra.error } : {}),
      });
      void exportSpans(spans);
    } catch (err) {
      console.error('[tracing] failed to finish/export run trace:', err instanceof Error ? err.message : err);
    }
  };

  const tried = new Set<string>();
  let result: Awaited<ReturnType<typeof callModel>> | undefined;

  for (;;) {
    tried.add(resolvedModelKey);
    try {
      result = await callModel(resolvedModelKey);
      modelHealth.recordSuccess(resolvedModelKey);
      break;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        finishTrace({ error: 'aborted', attributes: { 'harness.aborted': true } });
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const failureKind = classifyProviderFailure(message);
      if (failureKind) modelHealth.recordFailure(resolvedModelKey);
      const fallback =
        !isPinned && failureKind ? modelHealth.pickFallback(resolvedModelKey, registry, tried) : null;
      if (!fallback) {
        finishTrace({ error: message });
        throw err;
      }
      // A fallback restarts the whole run. If this attempt already ran a
      // write/destructive tool, the new model would redo it — fail instead.
      if (attemptHadSideEffects) {
        const sideEffectErr =
          `${message}\n(Not falling back to "${fallback}": the failed attempt on "${resolvedModelKey}" ` +
          `already executed write/destructive tool calls, which a restarted run would repeat.)`;
        finishTrace({ error: sideEffectErr });
        throw new Error(sideEffectErr);
      }
      console.warn(
        `[agent] model "${resolvedModelKey}" hit a provider ${failureKind} failure; ` +
          `falling back to same-tier "${fallback}".`
      );
      opts.onRestart?.({ fromModelKey: resolvedModelKey, toModelKey: fallback });
      resolvedModelKey = fallback;
    }
  }

  if (!result) throw new Error('unreachable: chat model call produced no result');

  const steps = result.steps.map((step, i) => toStepTrace(step, i));

  // The judge ran concurrently with the loop; await any still in flight now
  // (off the tool-call critical path) so the verdicts are captured with the
  // run record. drain() never rejects.
  const ragJudgments = ragJudgmentSink ? await ragJudgmentSink.drain() : [];

  const budgetUsage = budget.usage();
  // Item #8: finish the run trace with the run's totals (best-effort).
  finishTrace({
    attributes: {
      'gen_ai.response.finish_reasons': result.finishReason,
      'harness.usage.total_tokens': budgetUsage.tokens,
      'harness.duration_ms': budgetUsage.durationMs,
      ...(budgetUsage.costUsd !== undefined ? { 'harness.cost_usd': budgetUsage.costUsd } : {}),
      ...(stopReason ? { 'harness.stop_reason': stopReason } : {}),
    },
  });

  return {
    finalText: result.text,
    steps,
    toolsConsidered,
    finishReason: result.finishReason,
    modelKey: resolvedModelKey,
    ...(stopReason ? { stopReason } : {}),
    budgetUsage,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    ragJudgments,
    versions,
  };
}
