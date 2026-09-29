import { afterEach, describe, expect, it } from 'vitest';
import { callSignature, resolveBudget, RunBudgetTracker } from './run-budget';

afterEach(() => {
  for (const k of ['RUN_MAX_TOKENS', 'RUN_MAX_COST_USD', 'RUN_TIMEOUT_MS', 'RUN_MAX_IDENTICAL_CALLS', 'MODEL_PRICING_JSON']) delete process.env[k];
});

describe('resolveBudget', () => {
  it('has defaults for tokens, time and repeats, and no cost ceiling', () => {
    const b = resolveBudget();
    expect(b.maxTokens).toBe(1_500_000);
    expect(b.maxDurationMs).toBe(30 * 60_000);
    expect(b.maxIdenticalCalls).toBe(3);
    expect(b.maxCostUsd).toBeUndefined();
  });

  it('lets a request tighten but never loosen the env limits', () => {
    process.env.RUN_MAX_TOKENS = '10000';
    process.env.RUN_MAX_COST_USD = '2';
    expect(resolveBudget({ maxTokens: 500_000, maxCostUsd: 5 })).toMatchObject({ maxTokens: 10_000, maxCostUsd: 2 });
    expect(resolveBudget({ maxTokens: 5_000, maxCostUsd: 0.5 })).toMatchObject({ maxTokens: 5_000, maxCostUsd: 0.5 });
  });
});

describe('callSignature', () => {
  it('ignores key order', () => {
    expect(callSignature('t', { a: 1, b: { c: 2, d: 3 } })).toBe(callSignature('t', { b: { d: 3, c: 2 }, a: 1 }));
    expect(callSignature('t', { a: 1 })).not.toBe(callSignature('t', { a: 2 }));
  });
});

describe('RunBudgetTracker', () => {
  const limits = { maxTokens: 100, maxDurationMs: 1_000, maxIdenticalCalls: 3 };

  it('stops on the token budget', () => {
    const t = new RunBudgetTracker(limits, 'unknown', 0, () => 0);
    t.recordStep({ inputTokens: 40, outputTokens: 10 }, []);
    expect(t.exceeded()).toBeUndefined();
    t.recordStep({ inputTokens: 40, outputTokens: 10 }, []);
    expect(t.exceeded()).toBe('token-budget');
  });

  it('stops on the time budget, re-checking the clock', () => {
    let now = 0;
    const t = new RunBudgetTracker(limits, 'unknown', 0, () => now);
    expect(t.exceeded()).toBeUndefined();
    now = 1_000;
    expect(t.exceeded()).toBe('time-budget');
  });

  it('stops on the cost ceiling for a priced model', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ priced: { input: 1_000_000, output: 0 } });
    const t = new RunBudgetTracker({ ...limits, maxTokens: undefined, maxCostUsd: 5 }, 'priced', 0, () => 0);
    t.recordStep({ inputTokens: 4, outputTokens: 0 }, []);
    expect(t.exceeded()).toBeUndefined();
    t.recordStep({ inputTokens: 1, outputTokens: 0 }, []);
    expect(t.exceeded()).toBe('cost-budget');
    expect(t.usage().costUsd).toBe(5);
  });

  it('ignores the cost ceiling when the model has no price', () => {
    const t = new RunBudgetTracker({ ...limits, maxTokens: undefined, maxCostUsd: 0.000001 }, 'unknown', 0, () => 0);
    t.recordStep({ inputTokens: 1_000, outputTokens: 1_000 }, []);
    expect(t.exceeded()).toBeUndefined();
    expect(t.usage().costUsd).toBeUndefined();
  });

  it('warns once at the repeat limit, then stops if the model keeps repeating', () => {
    const t = new RunBudgetTracker(limits, 'unknown', 0, () => 0);
    const call = { toolName: 'adobe_list_segments', input: { limit: 5 } };
    t.recordStep({}, [call]);
    t.recordStep({}, [call]);
    expect(t.takeWarnings()).toEqual([]);
    t.recordStep({}, [call]);
    const warnings = t.takeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3 times with identical arguments');
    expect(t.takeWarnings()).toEqual([]);
    expect(t.exceeded()).toBeUndefined();
    t.recordStep({}, [call]);
    expect(t.exceeded()).toBe('loop-detected');
  });

  it('does not count different arguments as a repeat', () => {
    const t = new RunBudgetTracker(limits, 'unknown', 0, () => 0);
    for (let i = 0; i < 6; i++) t.recordStep({}, [{ toolName: 'adobe_list_segments', input: { page: i } }]);
    expect(t.takeWarnings()).toEqual([]);
    expect(t.exceeded()).toBeUndefined();
  });
});
