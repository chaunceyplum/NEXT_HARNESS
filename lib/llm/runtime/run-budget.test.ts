import { afterEach, describe, expect, it } from 'vitest';
import { callSignature, resolveBudget, RunBudgetTracker, RunLedger } from './run-budget';

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

  it('charges cache reads at the cache rate, so a cached prompt does not trip the ceiling', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ priced: { input: 1_000_000, output: 0, cacheRead: 100_000 } });
    const t = new RunBudgetTracker({ ...limits, maxTokens: undefined, maxCostUsd: 5 }, 'priced', 0, () => 0);
    // 10 input tokens, 9 of them read from cache: 1 × $1 + 9 × $0.1 = $1.9.
    t.recordStep({ inputTokens: 10, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 9 } }, []);
    expect(t.usage().costUsd).toBeCloseTo(1.9);
    expect(t.exceeded()).toBeUndefined();
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

describe('RunLedger', () => {
  it('keeps the input/output token split charged by child trackers', () => {
    const ledger = new RunLedger({ maxIdenticalCalls: 3 }, 0, () => 0);
    ledger.child('unknown', 1).recordStep({ inputTokens: 100, outputTokens: 20 }, []);
    ledger.charge(7, undefined, { inputTokens: 5, outputTokens: 2 });
    expect(ledger.tokenUsage()).toEqual({ inputTokens: 105, outputTokens: 22, totalTokens: 127 });
  });

  const limits = { maxTokens: 1_000, maxDurationMs: 10_000, maxIdenticalCalls: 3 };

  it('caps a child budget at a share of the ledger remaining tokens (8.2)', () => {
    const ledger = new RunLedger(limits, 0, () => 0);
    // Nothing spent yet: half of 1,000 tokens.
    const first = ledger.child('unknown', 0.5);
    first.recordStep({ inputTokens: 300, outputTokens: 100 }, []);
    expect(first.exceeded()).toBeUndefined();
    first.recordStep({ inputTokens: 100, outputTokens: 0 }, []);
    // Child's own 500-token slice is reached.
    expect(first.exceeded()).toBe('token-budget');
    expect(ledger.usage().tokens).toBe(500);

    // A later worker's slice is half of what's left (1,000 − 500 = 500) → 250.
    const second = ledger.child('unknown', 0.5);
    second.recordStep({ inputTokens: 250, outputTokens: 0 }, []);
    expect(second.exceeded()).toBe('token-budget');
  });

  it('charges every worker step to both the child and the run ledger (8.1, 8.3)', () => {
    const ledger = new RunLedger(limits, 0, () => 0);
    const a = ledger.child('unknown', 1);
    const b = ledger.child('unknown', 1);
    a.recordStep({ inputTokens: 100, outputTokens: 50 }, []);
    b.recordStep({ inputTokens: 200, outputTokens: 0 }, []);
    expect(a.usage().tokens).toBe(150);
    expect(b.usage().tokens).toBe(200);
    // Run ledger sums across workers.
    expect(ledger.usage().tokens).toBe(350);
  });

  it('reports exhaustion to a worker even when its child slice has room (8.1)', () => {
    const ledger = new RunLedger({ ...limits, maxTokens: 300 }, 0, () => 0);
    const a = ledger.child('unknown', 1); // slice = full 300
    const b = ledger.child('unknown', 1); // slice = full 300
    a.recordStep({ inputTokens: 300, outputTokens: 0 }, []);
    expect(ledger.exhausted()).toBe('token-budget');
    // b has used nothing of its own slice but must still report the run reason.
    expect(b.exceeded()).toBe('token-budget');
  });

  it('exhausts on the run cost ceiling across priced workers (8.1)', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ priced: { input: 1_000_000, output: 0 } });
    const ledger = new RunLedger({ ...limits, maxTokens: undefined, maxCostUsd: 5 }, 0, () => 0);
    const a = ledger.child('priced', 1);
    const b = ledger.child('priced', 1);
    a.recordStep({ inputTokens: 3, outputTokens: 0 }, []); // $3
    expect(ledger.exhausted()).toBeUndefined();
    b.recordStep({ inputTokens: 2, outputTokens: 0 }, []); // $2 → $5 total
    expect(ledger.exhausted()).toBe('cost-budget');
    expect(ledger.usage().costUsd).toBe(5);
  });

  it('exhausts on the run time limit, re-checking the clock (8.1)', () => {
    let now = 0;
    const ledger = new RunLedger(limits, 0, () => now);
    expect(ledger.exhausted()).toBeUndefined();
    now = 10_000;
    expect(ledger.exhausted()).toBe('time-budget');
  });

  it('keeps identical-call loop detection per worker (8.5)', () => {
    const ledger = new RunLedger(limits, 0, () => 0);
    const a = ledger.child('unknown', 1);
    const b = ledger.child('unknown', 1);
    const call = { toolName: 'adobe_list_segments', input: { limit: 5 } };
    // Worker a repeats the same call; worker b never does.
    for (let i = 0; i < 4; i++) a.recordStep({}, [call]);
    expect(a.exceeded()).toBe('loop-detected');
    expect(b.exceeded()).toBeUndefined();
  });

  it('a tracker with no parent behaves exactly as before (single-agent path)', () => {
    const t = new RunBudgetTracker({ ...limits, maxTokens: 100 }, 'unknown', 0, () => 0);
    t.recordStep({ inputTokens: 40, outputTokens: 10 }, []);
    expect(t.exceeded()).toBeUndefined();
    t.recordStep({ inputTokens: 40, outputTokens: 10 }, []);
    expect(t.exceeded()).toBe('token-budget');
  });
});
