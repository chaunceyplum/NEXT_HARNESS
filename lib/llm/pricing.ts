/**
 * Per-model token prices, for turning a run's token usage into an estimated
 * dollar cost (the evals' "cost per successful task").
 *
 * Defaults are Anthropic first-party list prices (USD per 1M tokens, as of
 * 2026-09). Bedrock bills Claude separately and may differ by region or
 * contract, and OpenAI has no defaults here, so override or extend with
 * MODEL_PRICING_JSON, keyed by registry key or model id:
 *   MODEL_PRICING_JSON='{"bedrock:balanced":{"input":2,"output":10},"gpt-4o":{"input":2.5,"output":10}}'
 * A model with no known price gets no cost (undefined), never a guess.
 */

import { getModelEntry } from './model-registry';
import type { TokenUsage } from '../types';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Matched as a substring of the model id, so Bedrock's "anthropic.…-v1:0" forms resolve too. */
const DEFAULT_PRICES: Array<[string, ModelPrice]> = [
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-opus-5-5', { input: 4, output: 20 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
];

function overrides(): Record<string, ModelPrice> {
  if (!process.env.MODEL_PRICING_JSON) return {};
  try {
    return JSON.parse(process.env.MODEL_PRICING_JSON) as Record<string, ModelPrice>;
  } catch (err) {
    console.error('[pricing] Failed to parse MODEL_PRICING_JSON:', err);
    return {};
  }
}

export function getModelPrice(modelKey: string): ModelPrice | undefined {
  let modelId: string | undefined;
  try {
    modelId = getModelEntry(modelKey).modelId;
  } catch {
    modelId = undefined;
  }
  const custom = overrides();
  if (custom[modelKey]) return custom[modelKey];
  if (modelId && custom[modelId]) return custom[modelId];
  if (!modelId) return undefined;
  return DEFAULT_PRICES.find(([id]) => modelId.includes(id))?.[1];
}

/** Estimated USD cost of one run's usage, or undefined if the price or token counts are unknown. */
export function estimateCostUsd(modelKey: string, usage: TokenUsage): number | undefined {
  const price = getModelPrice(modelKey);
  if (!price || usage.inputTokens == null || usage.outputTokens == null) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
