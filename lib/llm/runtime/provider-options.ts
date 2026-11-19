/**
 * Provider options for a run: prompt-cache markers, conversation-bound
 * thinking / server-side context editing, and extended thinking.
 */

import { type ModelMessage, type SystemModelMessage } from 'ai';
import { getModelEntry } from '../models/model-registry';
import { systemPrompt } from './agent-core';

// ── TASK 1: Prompt caching ────────────────────────────────────────────────────

/**
 * Cache markers for the system message, so the system prompt is cached after
 * the first call. The AI SDK's `toolOrder` stability (tools are never
 * shuffled) means tool definitions are also cache-eligible without per-tool
 * markup. Anthropic reads `cacheControl`; @ai-sdk/amazon-bedrock reads
 * `cachePoint` (and ignores cacheControl), and only Claude models on Bedrock
 * support it.
 */
export function buildSystemMessage(
  modelKey: string,
  toolDiscovery: boolean,
  memory = false,
  launchMode = false,
  publishEnabled = false,
  segmentMode = false
): SystemModelMessage {
  const providerOptions = cacheMarker(modelKey);
  return {
    role: 'system',
    content: systemPrompt({ toolDiscovery, memory, launchMode, publishEnabled, segmentMode }),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

/** The provider's cache breakpoint for a message, or undefined when the model can't cache. */
export function cacheMarker(modelKey: string): SystemModelMessage['providerOptions'] {
  const entry = tryGetModelEntry(modelKey);
  return entry?.provider === 'anthropic'
    ? { anthropic: { cacheControl: { type: 'ephemeral' } } }
    : entry?.provider === 'bedrock' && isClaudeModelId(entry.modelId)
      ? { bedrock: { cachePoint: { type: 'default' } } }
      : undefined;
}

/**
 * The conversation's cache breakpoint: the last message gets a marker each
 * step, so the next step reads the whole history so far from cache instead
 * of paying full price for it again. Together with the system prompt's
 * marker that's 2 of the 4 allowed. Moving a marker isn't a history edit, so
 * it's safe on history-bound models too.
 */
export function withCacheBreakpoint(messages: ModelMessage[], marker: SystemModelMessage['providerOptions']): ModelMessage[] {
  if (!marker || messages.length === 0) return messages;
  // Messages returned here stay in the SDK's history, so earlier steps' markers
  // are still on their messages: clear them, or they'd pile past the limit and
  // the provider would drop the newest one.
  const earlier = messages.slice(0, -1).map(withoutCacheMarker);
  const last = messages[messages.length - 1];
  return [...earlier, { ...last, providerOptions: { ...last.providerOptions, ...marker } } as ModelMessage];
}

function withoutCacheMarker(message: ModelMessage): ModelMessage {
  const opts = message.providerOptions as Record<string, Record<string, unknown>> | undefined;
  if (!opts?.anthropic?.cacheControl && !opts?.bedrock?.cachePoint) return message;
  const cleaned: Record<string, Record<string, unknown>> = {};
  for (const [provider, values] of Object.entries(opts)) {
    const { cacheControl: _c, cachePoint: _p, ...rest } = values;
    void _c;
    void _p;
    if (Object.keys(rest).length) cleaned[provider] = rest;
  }
  const { providerOptions: _old, ...base } = message;
  void _old;
  return (Object.keys(cleaned).length ? { ...base, providerOptions: cleaned } : base) as ModelMessage;
}


export function tryGetModelEntry(modelKey: string) {
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
 * think by default, so on them the loop must be append-only: no rewriting old
 * tool results, no dropping the tools array for a text-only last step, and no
 * forced tool_choice (Sonnet 5.5 and Opus 5.5 reject it, and the provider's
 * workaround sends only the forced tool, which changes the tools array).
 */
export const HISTORY_BOUND_MODEL_RE = /claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1|mythos-5-1)/i;

export function isHistoryBound(modelKey: string): boolean {
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
export function contextEditingProviderOptions(modelKey: string): ProviderOptions | undefined {
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
export function mergeProviderOptions(...parts: Array<ProviderOptions | undefined>): ProviderOptions | undefined {
  const merged: ProviderOptions = {};
  for (const part of parts) {
    for (const [provider, options] of Object.entries(part ?? {})) {
      merged[provider] = { ...merged[provider], ...options };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
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
export function resolveThinkingProviderOptions(
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
