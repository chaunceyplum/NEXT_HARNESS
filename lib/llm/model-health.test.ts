import { describe, expect, it } from 'vitest';
import {
  classifyProviderFailure,
  ModelHealthTracker,
  type ProviderFailureKind,
} from './model-health';
import type { ModelRegistryEntry } from './model-registry';

// A small registry mirroring the real tiers: two models per tier so there's a
// same-tier sibling to fall back to.
const REGISTRY: ModelRegistryEntry[] = [
  { key: 'bedrock:balanced', label: '', provider: 'bedrock', modelId: 'x', tier: 'balanced' },
  { key: 'anthropic:sonnet', label: '', provider: 'anthropic', modelId: 'y', tier: 'balanced' },
  { key: 'bedrock:cheap', label: '', provider: 'bedrock', modelId: 'z', tier: 'cheap' },
  { key: 'anthropic:haiku', label: '', provider: 'anthropic', modelId: 'w', tier: 'cheap' },
  { key: 'bedrock:expensive', label: '', provider: 'bedrock', modelId: 'e', tier: 'expensive' },
];

describe('classifyProviderFailure', () => {
  it.each<[string, ProviderFailureKind | null]>([
    ['[chat model call (bedrock:balanced)] Forbidden', 'access'],
    ['[chat model call (bedrock:cheap)] Operation not allowed', 'access'],
    ['anthropic.claude-sonnet-5 is not available for this account', 'access'],
    ['[chat model call (anthropic:haiku)] invalid x-api-key', 'auth'],
    ["Anthropic API key is missing. Pass it using the 'apiKey' parameter", 'auth'],
    ['Your credit balance is too low to access the Anthropic API.', 'quota'],
    // Context overflow is deliberately NOT a health failure — a same-tier
    // sibling shares the same window, so switching wouldn't help.
    ['prompt is too long: 365912 tokens > 200000 maximum', null],
    ['some random tool bug', null],
  ])('classifies %j as %s', (message, expected) => {
    expect(classifyProviderFailure(message)).toBe(expected);
  });
});

describe('ModelHealthTracker', () => {
  it('a model is healthy until it crosses the failure threshold', () => {
    const now = 1000;
    const t = new ModelHealthTracker({ failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000, now: () => now });
    expect(t.isUnhealthy('bedrock:balanced')).toBe(false);
    t.recordFailure('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(false); // 1 < threshold
    t.recordFailure('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(true); // tripped
  });

  it('failures outside the rolling window do not accumulate', () => {
    let now = 0;
    const t = new ModelHealthTracker({ failureThreshold: 2, windowMs: 1_000, cooldownMs: 5_000, now: () => now });
    t.recordFailure('bedrock:balanced');
    now = 2_000; // first failure is now outside the 1s window
    t.recordFailure('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(false);
  });

  it('a tripped model recovers after the cooldown elapses', () => {
    let now = 0;
    const t = new ModelHealthTracker({ failureThreshold: 1, windowMs: 10_000, cooldownMs: 1_000, now: () => now });
    t.recordFailure('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(true);
    now = 1_500; // past cooldown
    expect(t.isUnhealthy('bedrock:balanced')).toBe(false);
  });

  it('a success clears failure history', () => {
    const t = new ModelHealthTracker({ failureThreshold: 1 });
    t.recordFailure('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(true);
    t.recordSuccess('bedrock:balanced');
    expect(t.isUnhealthy('bedrock:balanced')).toBe(false);
  });

  it('picks a healthy same-tier sibling as fallback', () => {
    const t = new ModelHealthTracker();
    expect(t.pickFallback('bedrock:balanced', REGISTRY)).toBe('anthropic:sonnet');
  });

  it('does not fall back across tiers', () => {
    const t = new ModelHealthTracker({ failureThreshold: 1 });
    // expensive tier has only one model — no same-tier sibling.
    expect(t.pickFallback('bedrock:expensive', REGISTRY)).toBeNull();
  });

  it('skips models already tried and models that are unhealthy', () => {
    const t = new ModelHealthTracker({ failureThreshold: 1 });
    // Trip the only sibling; then there is nothing healthy left in-tier.
    t.recordFailure('anthropic:sonnet');
    expect(t.pickFallback('bedrock:balanced', REGISTRY)).toBeNull();
    // And with a fresh tracker, excluding the sibling via `tried` also yields null.
    const t2 = new ModelHealthTracker();
    expect(t2.pickFallback('bedrock:balanced', REGISTRY, new Set(['anthropic:sonnet']))).toBeNull();
  });

  it('returns null fallback for an unknown model key', () => {
    const t = new ModelHealthTracker();
    expect(t.pickFallback('not-a-key', REGISTRY)).toBeNull();
  });
});
