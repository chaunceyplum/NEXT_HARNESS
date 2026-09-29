import { afterEach, describe, expect, it } from 'vitest';
import { computeProductionMetrics, isSuccess, type ProductionRunRow } from './production-metrics';

afterEach(() => {
  delete process.env.MODEL_PRICING_JSON;
});

const run = (over: Partial<ProductionRunRow> = {}): ProductionRunRow => ({
  id: Math.random().toString(36).slice(2),
  createdAt: '2026-09-29T00:00:00.000Z',
  description: 'list segments',
  model: 'm',
  status: 'completed',
  durationMs: 1_000,
  finishReason: 'stop',
  inputTokens: 1_000,
  outputTokens: 100,
  steps: 2,
  denied: 0,
  ...over,
});

describe('isSuccess', () => {
  it('needs a completed, self-stopped run that nobody graded bad', () => {
    expect(isSuccess(run())).toBe(true);
    expect(isSuccess(run({ status: 'failed' }))).toBe(false);
    expect(isSuccess(run({ finishReason: 'tool-calls' }))).toBe(false);
    expect(isSuccess(run({ stopReason: 'token-budget' }))).toBe(false);
    expect(isSuccess(run({ judgePass: false }))).toBe(false);
    expect(isSuccess(run({ rating: -1 }))).toBe(false);
    expect(isSuccess(run({ judgePass: true, rating: 1 }))).toBe(true);
  });
});

describe('computeProductionMetrics', () => {
  it('computes the headline rates, latency, escalation and review queue', () => {
    const rows = [
      run({ durationMs: 1_000 }),
      run({ durationMs: 2_000, denied: 1 }),
      run({ durationMs: 3_000, stopReason: 'loop-detected' }),
      run({ durationMs: 10_000, status: 'failed', steps: undefined }),
      run({ durationMs: 4_000, rating: -1, comment: 'wrong sandbox', createdAt: '2026-09-29T02:00:00.000Z' }),
      run({ durationMs: 5_000, judgePass: false, createdAt: '2026-09-29T01:00:00.000Z' }),
    ];
    const m = computeProductionMetrics(rows);
    expect(m.runs).toBe(6);
    expect(m.successes).toBe(2);
    expect(m.successRate).toBeCloseTo(2 / 6);
    expect(m.latencyP50Ms).toBe(3_000);
    expect(m.latencyP95Ms).toBe(10_000);
    expect(m.escalationRate).toBeCloseTo(1 / 6);
    expect(m.stopReasons).toEqual({ finished: 4, 'loop-detected': 1, failed: 1 });
    expect(m.judged).toBe(1);
    expect(m.judgePassRate).toBe(0);
    expect(m.thumbsDown).toBe(1);
    expect(m.needsReview.map((r) => r.comment ?? r.judgePass)).toEqual(['wrong sandbox', false]);
  });

  it('divides cost by successes, and reports none when a run is unpriced', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ priced: { input: 1_000_000, output: 0 } });
    const priced = [run({ model: 'priced', inputTokens: 1 }), run({ model: 'priced', inputTokens: 1, status: 'failed' })];
    const m = computeProductionMetrics(priced);
    expect(m.totalCostUsd).toBe(2);
    expect(m.costPerSuccessUsd).toBe(2);
    expect(m.byModel[0]).toMatchObject({ model: 'priced', runs: 2, successRate: 0.5, costPerSuccessUsd: 2 });

    expect(computeProductionMetrics([...priced, run({ model: 'unknown' })]).totalCostUsd).toBeUndefined();
  });

  it('handles an empty window', () => {
    expect(computeProductionMetrics([])).toMatchObject({ runs: 0, successRate: 0, escalationRate: 0, needsReview: [] });
  });
});
