import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, getModelPrice, toTokenUsage } from './pricing';

describe('pricing', () => {
  afterEach(() => {
    delete process.env.MODEL_PRICING_JSON;
  });

  it('resolves Bedrock-style and direct model ids to list prices', () => {
    expect(getModelPrice('bedrock:cheap')).toEqual({ input: 1, output: 5 });
    expect(getModelPrice('anthropic:sonnet')).toEqual({ input: 2, output: 10 });
    expect(getModelPrice('anthropic:opus')).toEqual({ input: 5, output: 25 });
  });

  it('estimates cost from token usage', () => {
    expect(estimateCostUsd('anthropic:haiku', { inputTokens: 1_000_000, outputTokens: 200_000 })).toBeCloseTo(2);
  });

  it('prices cached input at the cache rates', () => {
    // sonnet: $2 in / $10 out. 1M input of which 800K cache reads (0.1×) and 100K cache writes (1.25×).
    const cost = estimateCostUsd('anthropic:sonnet', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 100_000,
    });
    expect(cost).toBeCloseTo(0.1 * 2 + 0.8 * 0.2 + 0.1 * 2.5);
    expect(estimateCostUsd('anthropic:sonnet', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2);
  });

  it('keeps the cache split from an AI SDK usage object', () => {
    expect(toTokenUsage({ inputTokens: 10, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 0 } })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: undefined,
      cacheReadTokens: 7,
    });
  });

  it('returns undefined rather than guessing', () => {
    expect(estimateCostUsd('anthropic:haiku', { inputTokens: 10 })).toBeUndefined();
    expect(getModelPrice('no-such-model')).toBeUndefined();
  });

  it('lets MODEL_PRICING_JSON override by registry key', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ 'bedrock:cheap': { input: 0.8, output: 4 } });
    expect(getModelPrice('bedrock:cheap')).toEqual({ input: 0.8, output: 4 });
  });
});
