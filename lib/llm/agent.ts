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

import { generateText, stepCountIs, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai';
import { getDefaultModelKey, getModelRegistry, resolveModel, getModelEntry } from './model-registry';
import { buildAiTools, getMcpToolCatalog } from './tool-catalog';
import { buildDiscoveryTools, effectiveToolCall } from './tool-discovery';
import { shortlistTools } from './tool-retrieval';
import { ALWAYS_ON_TOOLS, systemPrompt, stage, type AgentStepTrace } from './agent-core';
import { classifyProviderFailure, defaultModelHealth, ModelHealthTracker } from './model-health';
import { applyToolPolicy, classifyTool, resolvePolicy, type PolicyMode } from './tool-policy';

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
}

export interface RunAgentOptions {
  userInput: string;
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
  /** Aborts the run (model calls and the step loop) — wired to the client disconnecting / hitting Stop. */
  abortSignal?: AbortSignal;
  /**
   * Called when a provider failure makes the run restart from scratch on a
   * same-tier fallback model. Steps already reported via onStep belong to the
   * abandoned attempt and should be discarded.
   */
  onRestart?: (info: { fromModelKey: string; toModelKey: string }) => void;
  /**
   * TASK 9: asks a human to approve one destructive tool call (delete_*,
   * abort_*, privacy jobs, merge_pr — including ones routed via call_tool)
   * before it runs. Not consulted in dry-run mode, where destructive tools
   * don't execute. On a live run without an approver, destructive calls are
   * denied. The eval path (opts.tools) is never gated.
   */
  approveTool?: (call: { toolCallId: string; toolName: string; input: unknown }) => Promise<{ approved: boolean; reason?: string }>;
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
  policy: { mode?: PolicyMode; dryRun?: boolean }
): Promise<LiveToolSelection> {
  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(userInput, { k: toolShortlistSize, exclude: alwaysOn })
  );

  // TASK 9: the policy runs over the whole catalog, so a tool reached via
  // call_tool is filtered/dry-run-wrapped exactly like a shortlisted one.
  const callable = applyToolPolicy(buildAiTools(catalog, { maxRetries: toolRetries }), policy);

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
 * Walk step.content directly — tool-error parts are NOT in step.toolResults
 * but we want them visible in the trace.
 */
function toStepTrace(step: { text: string; content: ReadonlyArray<{ type: string }> }, stepNumber: number): AgentStepTrace {
  const toolCalls: AgentStepTrace['toolCalls'] = [];
  const toolResults: AgentStepTrace['toolResults'] = [];

  type Part = {
    type: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    result?: unknown;
    error?: unknown;
    approved?: boolean;
    reason?: string;
    toolCall?: { toolName: string };
  };
  for (const part of step.content as ReadonlyArray<Part>) {
    if (part.type === 'tool-approval-response' && part.approved === false && part.toolCall) {
      // Denied calls never produce a tool-result/tool-error part.
      toolResults.push({ toolName: part.toolCall.toolName, output: undefined, error: `Not executed: ${part.reason ?? 'denied'}` });
    } else if (part.type === 'tool-call') {
      toolCalls.push({ toolName: part.toolName, input: part.input });
    } else if (part.type === 'tool-result') {
      // StaticToolResult uses .output; DynamicToolResult uses .result
      toolResults.push({ toolName: part.toolName, output: part.output ?? part.result });
    } else if (part.type === 'tool-error') {
      const errVal = part.error;
      toolResults.push({
        toolName: part.toolName,
        output: undefined,
        error: errVal instanceof Error ? errVal.message : String(errVal),
      });
    }
  }

  return { stepNumber, text: step.text, toolCalls, toolResults };
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

  if (opts.tools) {
    // Evals pass opts.tools and bypass the tool policy so scripted tool
    // fixtures aren't accidentally filtered.
    tools = opts.tools;
    toolsConsidered = Object.keys(opts.tools);
  } else {
    const live = await selectLiveTools(userInput, toolShortlistSize, toolRetries, {
      mode: opts.policy,
      dryRun: opts.dryRun,
    });
    tools = live.tools;
    toolsConsidered = live.toolsConsidered;
  }

  // TASK 9: gate destructive calls on a human decision (live runs only).
  const { dryRun } = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const toolApproval = opts.tools
    ? undefined
    : async ({ toolCall }: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => {
        const call = effectiveToolCall(toolCall.toolName, toolCall.input);
        if (dryRun || classifyTool(call.toolName) !== 'destructive') return 'not-applicable' as const;
        if (!opts.approveTool) {
          return { type: 'denied' as const, reason: 'Destructive tool calls need a human approver, and none is attached to this run.' };
        }
        const decision = await opts.approveTool({ toolCallId: toolCall.toolCallId, ...call });
        return { type: decision.approved ? ('approved' as const) : ('denied' as const), reason: decision.reason };
      };

  const isPinned = Boolean(modelKey);
  const registry = getModelRegistry();

  // TASK 8: step counter for onStepEnd → onStep mapping. Reset per model
  // attempt, since a fallback restarts the run from scratch.
  let stepIndex = 0;
  // Whether the current attempt has executed a write/destructive tool call —
  // if so, falling back would re-run those side effects on the next model.
  let attemptHadSideEffects = false;

  const callModel = (resolvedModelKey: string) => {
    stepIndex = 0;
    attemptHadSideEffects = false;

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

    return stage(`chat model call (${resolvedModelKey})`, () =>
      generateText({
        model: resolveModel(resolvedModelKey),
        // TASK 1: system prompt with provider-specific cache markers
        instructions: buildSystemMessage(resolvedModelKey, 'find_tools' in tools),
        messages: [{ role: 'user', content: userInput }],
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: opts.abortSignal,
        // TASK 10 (thinking) + TASK 2 (server-side context editing)
        ...(providerOptions ? { providerOptions } : {}),
        ...(toolApproval ? { toolApproval } : {}),
        prepareStep: ({ steps, messages }) => {
          const isLastStep = steps.length >= maxSteps - 1;

          // History-bound models: append-only. Old tool results are cleared
          // server-side (providerOptions above), and the last step keeps the
          // tools array — toolChoice 'none' makes the providers drop it — and
          // instead appends an instruction after the latest tool results.
          if (historyBound) {
            return isLastStep ? { messages: [...messages, { role: 'user' as const, content: FINAL_STEP_NOTE }] } : {};
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
          return {
            toolChoice: isLastStep ? 'none' : 'auto',
            ...(compressedMessages ? { messages: compressedMessages } : {}),
          };
        },
        // TASK 8: fire onStep callback after each step so the route can stream it
        onStepEnd: (step) => {
          const trace = toStepTrace(step, stepIndex++);
          // Only calls that actually ran count — a denied call never executed.
          for (const part of step.content) {
            if (part.type !== 'tool-result' && part.type !== 'tool-error') continue;
            if (classifyTool(effectiveToolCall(part.toolName, part.input).toolName) !== 'read') attemptHadSideEffects = true;
          }
          opts.onStep?.(trace);
        },
      })
    );
  };

  let resolvedModelKey = modelKey || getDefaultModelKey();
  if (!isPinned && modelHealth.isUnhealthy(resolvedModelKey)) {
    const healthy = modelHealth.pickFallback(resolvedModelKey, registry);
    if (healthy) resolvedModelKey = healthy;
  }

  const tried = new Set<string>();
  let result: Awaited<ReturnType<typeof callModel>> | undefined;

  for (;;) {
    tried.add(resolvedModelKey);
    try {
      result = await callModel(resolvedModelKey);
      modelHealth.recordSuccess(resolvedModelKey);
      break;
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const failureKind = classifyProviderFailure(message);
      if (failureKind) modelHealth.recordFailure(resolvedModelKey);
      const fallback =
        !isPinned && failureKind ? modelHealth.pickFallback(resolvedModelKey, registry, tried) : null;
      if (!fallback) throw err;
      // A fallback restarts the whole run. If this attempt already ran a
      // write/destructive tool, the new model would redo it — fail instead.
      if (attemptHadSideEffects) {
        throw new Error(
          `${message}\n(Not falling back to "${fallback}": the failed attempt on "${resolvedModelKey}" ` +
            `already executed write/destructive tool calls, which a restarted run would repeat.)`
        );
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

  return {
    finalText: result.text,
    steps,
    toolsConsidered,
    finishReason: result.finishReason,
    modelKey: resolvedModelKey,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
