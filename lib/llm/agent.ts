/**
 * The agent loop that replaces the old fixed pipeline.
 *
 * Runtime optimisations layered on top of the basic generateText loop:
 *
 *   1. Prompt caching (TASK 1): the system prompt is sent as a messages-array
 *      system message with providerOptions.anthropic.cacheControl so Anthropic
 *      and Bedrock cache it after the first step. Tool definitions are similarly
 *      cached via toolOrder stability (shortlist never shuffles). Cache-write on
 *      the first step, much-cheaper cache-read on every subsequent step.
 *
 *   2. prepareStep context management (TASK 2): tool results from steps older
 *      than RESULT_SUMMARY_THRESHOLD are replaced with a compact one-line
 *      summary before each step, so they don't accumulate at full size across a
 *      long run. Results are already captured in the trace at call time, so
 *      nothing is lost for the user — only the in-flight model context shrinks.
 *
 *   3. Last-step summary (TASK 3): toolChoice is forced to 'none' for the final
 *      allowed step so the model always writes a coherent closing answer rather
 *      than being cut off mid-tool-call when stepCountIs fires.
 *
 *   6. find_tools mid-run expansion (TASK 6): a synthetic `find_tools` tool is
 *      always-on. When the model calls it, the returned names are added to the
 *      active set for the remaining steps via prepareStep's activeTools.
 */

import { generateText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { tool, jsonSchema } from 'ai';
import { getDefaultModelKey, getModelRegistry, resolveModel, getModelEntry } from './model-registry';
import { buildAiTools, getMcpToolCatalog, type McpToolDefinition } from './tool-catalog';
import { shortlistTools } from './tool-retrieval';
import { ALWAYS_ON_TOOLS, systemPrompt, stage, type AgentStepTrace } from './agent-core';
import { classifyProviderFailure, defaultModelHealth, ModelHealthTracker } from './model-health';
import { applyToolPolicy } from './tool-policy';

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
   * Defaults to the BUILD_POLICY env var, or 'full' if unset.
   */
  policy?: import('./tool-policy').PolicyMode;
  /**
   * TASK 9: When true, wraps destructive tools to return a dry-run description
   * instead of executing. Defaults to TOOL_DRY_RUN env var.
   */
  dryRun?: boolean;
  /**
   * TASK 10: Enable extended thinking (Anthropic / Bedrock only).
   * Sets a token budget for the model's internal reasoning before it responds.
   * Ignored for non-Anthropic providers (OpenAI). Effective on balanced and
   * expensive tiers; has limited benefit on cheap/haiku models.
   *
   * Minimum 1 000 tokens (Anthropic's documented minimum). A good starting
   * point for complex multi-step tasks is 8 000–16 000. Higher budgets improve
   * reasoning quality but increase cost and latency.
   *
   * Can also be set globally via THINKING_BUDGET_TOKENS env var (number).
   * Per-request value takes precedence over the env var.
   */
  thinkingBudget?: number;
}

// ── TASK 1: Prompt caching ────────────────────────────────────────────────────

/**
 * Anthropic / Bedrock cache_control marker. Applied to the system message so
 * the system prompt is cached after the first call. The AI SDK's `toolOrder`
 * stability (tools are never shuffled) means tool definitions are also cache-
 * eligible without per-tool markup.
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

/** Build the system message as a ModelMessage with cache control attached. */
function buildSystemMessage(): ModelMessage {
  return {
    role: 'system',
    content: systemPrompt(),
    providerOptions: {
      anthropic: { cacheControl: CACHE_CONTROL },
      // Bedrock uses the same providerOptions key name via @ai-sdk/amazon-bedrock
      bedrock: { cacheControl: CACHE_CONTROL },
    },
  };
}

// ── TASK 10: Extended thinking ────────────────────────────────────────────────

/** Minimum token budget Anthropic accepts for extended thinking. */
const THINKING_MIN_TOKENS = 1_000;

/**
 * Resolve the effective thinking budget for a run.
 * Per-request value takes precedence over the THINKING_BUDGET_TOKENS env var.
 * Returns undefined (thinking disabled) when the model is not Anthropic-family
 * or when no budget is configured.
 */
function resolveThinkingBudget(
  modelKey: string,
  perRequestBudget?: number
): number | undefined {
  // Only Anthropic (direct) and Bedrock (Claude) support extended thinking.
  const entry = (() => {
    try { return getModelEntry(modelKey); } catch { return undefined; }
  })();
  if (!entry || (entry.provider !== 'anthropic' && entry.provider !== 'bedrock')) return undefined;

  const budget =
    perRequestBudget ??
    (process.env.THINKING_BUDGET_TOKENS ? parseInt(process.env.THINKING_BUDGET_TOKENS, 10) : undefined);

  if (!budget || isNaN(budget) || budget < THINKING_MIN_TOKENS) return undefined;
  return budget;
}

/**
 * Build the providerOptions block for extended thinking, or undefined if
 * thinking is not enabled for this run.
 */
function buildThinkingProviderOptions(
  budgetTokens: number
): Record<string, Record<string, unknown>> {
  const thinking = { thinking: { type: 'enabled', budgetTokens } };
  return {
    anthropic: thinking,
    bedrock: thinking,
  };
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
 * behind the documented 400K-token run). The full results remain in the trace
 * — only the model's in-flight context is shrunk.
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
  tools: ToolSet;
  toolsConsidered: string[];
  allCatalogNames: Set<string>;
  catalog: McpToolDefinition[];
}

async function selectLiveTools(
  userInput: string,
  toolShortlistSize: number,
  toolRetries: number
): Promise<LiveToolSelection> {
  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(userInput, { k: toolShortlistSize, exclude: alwaysOn })
  );

  const selectedNames = new Set<string>([...alwaysOn, ...shortlisted]);
  const selectedDefs = [...selectedNames]
    .map((name) => catalogByName.get(name))
    .filter((d): d is McpToolDefinition => Boolean(d));

  const tools = buildAiTools(selectedDefs, { maxRetries: toolRetries });

  // TASK 6: add find_tools to the always-on set
  tools['find_tools'] = buildFindToolsTool(catalog);

  return {
    tools,
    toolsConsidered: [...selectedNames],
    allCatalogNames: new Set(catalog.map((t) => t.name)),
    catalog,
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
  let allCatalogNames: Set<string>;

  if (opts.tools) {
    tools = opts.tools;
    toolsConsidered = Object.keys(opts.tools);
    allCatalogNames = new Set(toolsConsidered);
  } else {
    const live = await selectLiveTools(userInput, toolShortlistSize, toolRetries);
    tools = live.tools;
    toolsConsidered = live.toolsConsidered;
    allCatalogNames = live.allCatalogNames;
  }

  // TASK 9: apply tool policy (read-only mode, dry-run) before handing
  // the tool set to the model. Evals pass opts.tools and bypass this so
  // scripted tool fixtures aren't accidentally filtered.
  if (!opts.tools) {
    tools = applyToolPolicy(tools, { mode: opts.policy, dryRun: opts.dryRun });
  }

  // TASK 6: tracks tool names added mid-run by find_tools calls
  const expandedToolNames = new Set<string>(toolsConsidered);

  const isPinned = Boolean(modelKey);
  const registry = getModelRegistry();

  // TASK 1: system prompt as a cacheable messages-array entry
  const systemMessage = buildSystemMessage();

  // TASK 8: step counter for onStepEnd → onStep mapping
  let stepIndex = 0;

  const callModel = (resolvedModelKey: string) => {
    // TASK 10: resolve thinking budget for this model + request combination
    const thinkingBudget = resolveThinkingBudget(resolvedModelKey, opts.thinkingBudget);
    const thinkingProviderOptions = thinkingBudget
      ? (buildThinkingProviderOptions(thinkingBudget) as Record<string, Record<string, never>>)
      : undefined;

    if (thinkingBudget) {
      console.log(`[agent] extended thinking enabled: ${thinkingBudget} token budget (${resolvedModelKey})`);
    }

    return stage(`chat model call (${resolvedModelKey})`, () =>
      generateText({
        model: resolveModel(resolvedModelKey),
        messages: [
          systemMessage,
          { role: 'user', content: userInput },
        ],
        tools,
        stopWhen: stepCountIs(maxSteps),
        // TASK 10: merge thinking providerOptions when budget is set
        ...(thinkingProviderOptions ? { providerOptions: thinkingProviderOptions } : {}),
        prepareStep: ({ steps, messages }) => {
          // TASK 6: scan completed steps for find_tools results and expand active set
          for (const step of steps) {
            for (const part of step.content) {
              if (part.type === 'tool-result' && part.toolName === 'find_tools') {
                const resultVal = (part as unknown as { output?: unknown; result?: unknown }).output
                  ?? (part as unknown as { result?: unknown }).result;
                if (resultVal && typeof resultVal === 'object' && Array.isArray((resultVal as Record<string, unknown>).tools)) {
                  for (const name of (resultVal as { tools: string[] }).tools) {
                    if (allCatalogNames.has(name)) expandedToolNames.add(name);
                  }
                }
              }
            }
          }

          // TASK 2: compress tool results from steps older than the threshold
          // so large list/read payloads don't accumulate at full size in the
          // context that's resent on every turn. The full results remain in
          // the trace (captured via onStep / result.steps); only the in-flight
          // model context is shrunk. Only compress when there's enough history
          // to be worth it — the most recent RESULT_SUMMARY_THRESHOLD steps
          // stay at full fidelity.
          const compressedMessages = compressOldToolMessages(messages, steps.length);

          // TASK 3: force text-only on the last two steps
          const isLastStep = steps.length >= maxSteps - 2;
          return {
            toolChoice: isLastStep ? 'none' : 'auto',
            activeTools: expandedToolNames.size > 0
              ? ([...expandedToolNames, 'find_tools'] as Array<keyof typeof tools>)
              : undefined,
            ...(compressedMessages ? { messages: compressedMessages } : {}),
          };
        },
        // TASK 8: fire onStep callback after each step so the route can stream it
        onStepEnd: opts.onStep
          ? (step) => {
              const toolCalls: AgentStepTrace['toolCalls'] = [];
              const toolResults: AgentStepTrace['toolResults'] = [];
              for (const part of step.content) {
                if (part.type === 'tool-call') {
                  toolCalls.push({ toolName: part.toolName, input: part.input });
                } else if (part.type === 'tool-result') {
                  const outputVal = (part as unknown as { output?: unknown }).output
                    ?? (part as unknown as { result?: unknown }).result;
                  toolResults.push({ toolName: part.toolName, output: outputVal });
                } else if (part.type === 'tool-error') {
                  const errVal = (part as { error?: unknown }).error;
                  toolResults.push({
                    toolName: part.toolName,
                    output: undefined,
                    error: errVal instanceof Error ? errVal.message : String(errVal),
                  });
                }
              }
              opts.onStep!({ stepNumber: stepIndex++, text: step.text, toolCalls, toolResults });
            }
          : undefined,
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
      const message = err instanceof Error ? err.message : String(err);
      const failureKind = classifyProviderFailure(message);
      if (failureKind) modelHealth.recordFailure(resolvedModelKey);
      const fallback =
        !isPinned && failureKind ? modelHealth.pickFallback(resolvedModelKey, registry, tried) : null;
      if (!fallback) throw err;
      console.warn(
        `[agent] model "${resolvedModelKey}" hit a provider ${failureKind} failure; ` +
          `falling back to same-tier "${fallback}".`
      );
      resolvedModelKey = fallback;
    }
  }

  if (!result) throw new Error('unreachable: chat model call produced no result');

  // Walk step.content directly — tool-error parts are NOT in step.toolResults
  // but we want them visible in the trace.
  const steps: AgentStepTrace[] = result.steps.map((step, i) => {
    const toolCalls: AgentStepTrace['toolCalls'] = [];
    const toolResults: AgentStepTrace['toolResults'] = [];

    for (const part of step.content) {
      if (part.type === 'tool-call') {
        toolCalls.push({ toolName: part.toolName, input: part.input });
      } else if (part.type === 'tool-result') {
        // StaticToolResult uses .output; DynamicToolResult uses .result
        const outputVal = (part as unknown as { output?: unknown }).output
          ?? (part as unknown as { result?: unknown }).result;
        toolResults.push({ toolName: part.toolName, output: outputVal });
      } else if (part.type === 'tool-error') {
        const errVal = (part as { error?: unknown }).error;
        toolResults.push({
          toolName: part.toolName,
          output: undefined,
          error: errVal instanceof Error ? errVal.message : String(errVal),
        });
      }
    }

    return { stepNumber: i, text: step.text, toolCalls, toolResults };
  });

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
