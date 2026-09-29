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
 *   2. prepareStep context management (TASK 2): tool results from steps older
 *      than RESULT_SUMMARY_THRESHOLD are replaced with a compact one-line
 *      summary before each step, so they don't accumulate at full size across a
 *      long run. The trace keeps the uncompressed results (each already capped at
 *      12K chars by capToolResult) — only the in-flight model context shrinks.
 *
 *   3. Last-step summary (TASK 3): toolChoice is forced to 'none' for the final
 *      allowed step so the model always writes a coherent closing answer rather
 *      than being cut off mid-tool-call when stepCountIs fires. (So with
 *      maxSteps=1 the run is text-only.)
 *
 *   6. find_tools mid-run expansion (TASK 6): every catalog tool is built and
 *      passed to generateText, but prepareStep's activeTools narrows what the
 *      model sees to the shortlist plus the always-on synthetic `find_tools`.
 *      When the model calls find_tools, the returned names join the active set
 *      for the remaining steps.
 */

import { generateText, stepCountIs, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai';
import { tool, jsonSchema } from 'ai';
import { getDefaultModelKey, getModelRegistry, resolveModel, getModelEntry } from './model-registry';
import { buildAiTools, getMcpToolCatalog, type McpToolDefinition } from './tool-catalog';
import { shortlistTools } from './tool-retrieval';
import { ALWAYS_ON_TOOLS, systemPrompt, stage, type AgentStepTrace } from './agent-core';
import { classifyProviderFailure, defaultModelHealth, ModelHealthTracker } from './model-health';
import { applyToolPolicy, classifyTool, type PolicyMode } from './tool-policy';

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
  /** Extra attempts per failed tool call, each preceded by a RAG lookup for context. 0 disables retrying. */
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
function buildSystemMessage(modelKey: string): SystemModelMessage {
  const entry = tryGetModelEntry(modelKey);
  const providerOptions: SystemModelMessage['providerOptions'] =
    entry?.provider === 'anthropic'
      ? { anthropic: { cacheControl: { type: 'ephemeral' } } }
      : entry?.provider === 'bedrock' && isClaudeModelId(entry.modelId)
        ? { bedrock: { cachePoint: { type: 'default' } } }
        : undefined;
  return { role: 'system', content: systemPrompt(), ...(providerOptions ? { providerOptions } : {}) };
}

function tryGetModelEntry(modelKey: string) {
  try { return getModelEntry(modelKey); } catch { return undefined; }
}

function isClaudeModelId(modelId: string): boolean {
  return /claude/i.test(modelId);
}

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
): Record<string, Record<string, unknown>> | undefined {
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

// ── TASK 3 + TASK 6: prepareStep hook ────────────────────────────────────────
// Implemented inline in runAgent's callModel closure (see below) so it has
// direct access to maxSteps, expandedToolNames, and allCatalogNames without
// extra indirection.

// ── TASK 6: find_tools synthetic tool ────────────────────────────────────────

/**
 * A lightweight synthetic tool always included in the model's tool set.
 * When the model discovers mid-run that it needs a tool not in its initial
 * shortlist, it calls find_tools(query) to get candidates from the full
 * catalog. The prepareStep hook then adds the returned names to activeTools
 * for subsequent steps.
 *
 * Returns up to 10 matching tool names. The model must pick the right one
 * from the results and proceed — this is a retrieval hint, not execution.
 */
function buildFindToolsTool(catalog: McpToolDefinition[]) {
  const nameIndex = catalog.map((t) => ({
    name: t.name,
    text: `${t.name}: ${t.description || ''}`.toLowerCase(),
  }));

  return tool({
    description:
      'Search the full tool catalog for tools you need but do not currently have access to. ' +
      'Call this when you realize a needed tool is not in your current tool set. ' +
      'Returns up to 10 matching tool names — the matching tools will be made available to you in the next step.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A short phrase describing the capability you need, e.g. "get merge policy" or "delete segment".',
        },
      },
      required: ['query'],
    }),
    execute: async ({ query }: { query: string }) => {
      const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const scored = nameIndex
        .map((entry) => ({
          name: entry.name,
          score: q.reduce((s, token) => s + (entry.text.includes(token) ? 1 : 0), 0),
        }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((e) => e.name);
      return { tools: scored, message: `Found ${scored.length} matching tool(s). They will be active on your next step.` };
    },
  });
}

// ── Tool selection ────────────────────────────────────────────────────────────

interface LiveToolSelection {
  /** Every catalog tool that survived the policy, plus find_tools and policy_info. */
  tools: ToolSet;
  /** The initial active set: always-on tools plus the semantic shortlist. */
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

  // TASK 6: build the whole catalog, not just the shortlist — activeTools can
  // only select from tools passed to generateText, so a tool find_tools
  // discovers must already exist here to be activated later. Only the active
  // subset is sent to the model on each step.
  //
  // TASK 9: the policy runs over the whole catalog, so a tool activated
  // mid-run via find_tools is filtered/dry-run-wrapped like any other.
  const tools = applyToolPolicy(buildAiTools(catalog, { maxRetries: toolRetries }), policy);

  // Index only tools that survived the policy, so find_tools never suggests
  // one read-only mode removed.
  tools['find_tools'] = buildFindToolsTool(catalog.filter((t) => t.name in tools));

  return {
    tools,
    toolsConsidered: [...new Set([...alwaysOn, ...shortlisted])].filter((name) => name in tools),
  };
}

// ── Step trace ────────────────────────────────────────────────────────────────

/**
 * Walk step.content directly — tool-error parts are NOT in step.toolResults
 * but we want them visible in the trace.
 */
function toStepTrace(step: { text: string; content: ReadonlyArray<{ type: string }> }, stepNumber: number): AgentStepTrace {
  const toolCalls: AgentStepTrace['toolCalls'] = [];
  const toolResults: AgentStepTrace['toolResults'] = [];

  for (const part of step.content as ReadonlyArray<{ type: string; toolName: string; input?: unknown; output?: unknown; result?: unknown; error?: unknown }>) {
    if (part.type === 'tool-call') {
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
  // TASK 6: names the model can see on each step; find_tools results are
  // added mid-run. Undefined on the eval path (opts.tools), which has no
  // find_tools and exposes its whole scripted set every step.
  let activeToolNames: Set<string> | undefined;

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
    activeToolNames = new Set([...toolsConsidered, 'find_tools', 'policy_info']);
  }

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
    const thinkingProviderOptions = resolveThinkingProviderOptions(resolvedModelKey, opts.thinkingBudget) as
      | Record<string, Record<string, never>>
      | undefined;
    if (thinkingProviderOptions) {
      console.log(`[agent] extended thinking enabled (${resolvedModelKey}): ${JSON.stringify(thinkingProviderOptions)}`);
    }

    return stage(`chat model call (${resolvedModelKey})`, () =>
      generateText({
        model: resolveModel(resolvedModelKey),
        // TASK 1: system prompt with provider-specific cache markers
        instructions: buildSystemMessage(resolvedModelKey),
        messages: [{ role: 'user', content: userInput }],
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: opts.abortSignal,
        // TASK 10: merge thinking providerOptions when budget is set
        ...(thinkingProviderOptions ? { providerOptions: thinkingProviderOptions } : {}),
        prepareStep: ({ steps, messages }) => {
          // TASK 6: scan completed steps for find_tools results and expand active set
          for (const step of steps) {
            for (const part of step.content) {
              if (part.type === 'tool-result' && part.toolName === 'find_tools') {
                const resultVal = (part as unknown as { output?: unknown; result?: unknown }).output
                  ?? (part as unknown as { result?: unknown }).result;
                if (activeToolNames && resultVal && typeof resultVal === 'object' && Array.isArray((resultVal as Record<string, unknown>).tools)) {
                  for (const name of (resultVal as { tools: string[] }).tools) {
                    if (name in tools) activeToolNames.add(name);
                  }
                }
              }
            }
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
          const isLastStep = steps.length >= maxSteps - 1;
          return {
            toolChoice: isLastStep ? 'none' : 'auto',
            activeTools: activeToolNames ? [...activeToolNames] : undefined,
            ...(compressedMessages ? { messages: compressedMessages } : {}),
          };
        },
        // TASK 8: fire onStep callback after each step so the route can stream it
        onStepEnd: (step) => {
          const trace = toStepTrace(step, stepIndex++);
          if (trace.toolCalls.some((c) => classifyTool(c.toolName) !== 'read')) attemptHadSideEffects = true;
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
