import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, getModelPrice } from './pricing';

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

  it('returns undefined rather than guessing', () => {
    expect(estimateCostUsd('anthropic:haiku', { inputTokens: 10 })).toBeUndefined();
    expect(getModelPrice('no-such-model')).toBeUndefined();
  });

  it('lets MODEL_PRICING_JSON override by registry key', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ 'bedrock:cheap': { input: 0.8, output: 4 } });
    expect(getModelPrice('bedrock:cheap')).toEqual({ input: 0.8, output: 4 });
  });
});
