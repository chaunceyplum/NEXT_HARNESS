import { describe, expect, it } from 'vitest';
import { computeRunMetrics, percentile } from './eval-metrics';
import type { EvalTrialRecord } from './types';

const trial = (fixtureId: string, passed: boolean, extra: Partial<EvalTrialRecord> = {}): EvalTrialRecord => ({
  fixtureId,
  trial: 1,
  passed,
  notes: '',
  ...extra,
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe('computeRunMetrics', () => {
  it('separates pass@k from pass^k', () => {
    const m = computeRunMetrics([
      trial('a', true), trial('a', true), trial('a', true),
      trial('b', true), trial('b', false), trial('b', true),
      trial('c', false), trial('c', false), trial('c', false),
    ]);
    expect(m.k).toBe(3);
    expect(m.fixtures).toBe(3);
    expect(m.successRate).toBeCloseTo(5 / 9);
    expect(m.passAtK).toBeCloseTo(2 / 3);
    expect(m.passHatK).toBeCloseTo(1 / 3);
  });

  it('divides cost and tokens by successes, not runs', () => {
    const m = computeRunMetrics([
      trial('a', true, { costUsd: 0.1, totalTokens: 100, durationMs: 1000, steps: 2, structuralPassed: true }),
      trial('a', false, { costUsd: 0.3, totalTokens: 300, durationMs: 3000, steps: 6, structuralPassed: false, safetyViolation: true }),
    ]);
    expect(m.totalCostUsd).toBeCloseTo(0.4);
    expect(m.costPerSuccessUsd).toBeCloseTo(0.4);
    expect(m.tokensPerSuccess).toBe(400);
    expect(m.stepsMean).toBe(4);
    expect(m.toolCallAccuracy).toBe(0.5);
    expect(m.safetyViolationRate).toBe(0.5);
    expect(m.latencyP95Ms).toBe(3000);
  });

  it('omits cost when any trial is unpriced instead of undercounting', () => {
    const m = computeRunMetrics([trial('a', true, { costUsd: 0.1 }), trial('b', true)]);
    expect(m.totalCostUsd).toBeUndefined();
    expect(m.costPerSuccessUsd).toBeUndefined();
  });
});
