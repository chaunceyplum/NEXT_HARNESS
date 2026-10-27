import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateMode, orchestrateModes, withOrchestration } from './env';
import { compareToRolloutBar } from './report';
import type { EvalRunMetrics } from '@/lib/eval-metrics';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('orchestrateMode / orchestrateModes (EVAL_ORCHESTRATE)', () => {
  it('defaults to off (single-agent only)', () => {
    delete process.env.EVAL_ORCHESTRATE;
    expect(orchestrateMode()).toBe('off');
    expect(orchestrateModes()).toEqual(['off']);
  });

  it('reads on and both, case-insensitively', () => {
    process.env.EVAL_ORCHESTRATE = 'ON';
    expect(orchestrateMode()).toBe('on');
    expect(orchestrateModes()).toEqual(['on']);
    process.env.EVAL_ORCHESTRATE = 'both';
    expect(orchestrateMode()).toBe('both');
    expect(orchestrateModes()).toEqual(['off', 'on']);
  });

  it('treats an unknown value as off', () => {
    process.env.EVAL_ORCHESTRATE = 'sometimes';
    expect(orchestrateMode()).toBe('off');
  });
});

describe('withOrchestration', () => {
  it('forces ORCHESTRATION for the callback and restores it afterward', async () => {
    process.env.ORCHESTRATION = 'off';
    const seen = await withOrchestration('on', async () => process.env.ORCHESTRATION);
    expect(seen).toBe('on');
    expect(process.env.ORCHESTRATION).toBe('off');
  });

  it('restores an unset variable to unset even when the callback throws', async () => {
    delete process.env.ORCHESTRATION;
    await expect(
      withOrchestration('on', async () => {
        expect(process.env.ORCHESTRATION).toBe('on');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(process.env.ORCHESTRATION).toBeUndefined();
  });
});

describe('compareToRolloutBar (requirements.md rollout bar)', () => {
  const metrics = (over: Partial<EvalRunMetrics>): EvalRunMetrics => ({
    fixtures: 2,
    trials: 2,
    errored: 0,
    k: 1,
    successRate: 1,
    passAtK: 1,
    passHatK: 1,
    safetyViolationRate: 0,
    safetyViolations: 0,
    latencyP50Ms: 10_000,
    latencyP95Ms: 20_000,
    totalCostUsd: 1,
    ...over,
  });

  it('clears the bar: pass held, ≥30% faster, ≤25% costlier', () => {
    const off = metrics({});
    const on = metrics({ latencyP50Ms: 6_000, totalCostUsd: 1.2 }); // -40% time, +20% cost
    const v = compareToRolloutBar(off, on);
    expect(v).toMatchObject({ passRateHeld: true, wallClockMet: true, costMet: true, met: true });
    expect(v.wallClockDelta).toBeCloseTo(-0.4);
    expect(v.costDelta).toBeCloseTo(0.2);
  });

  it('fails when wall-clock improvement is under 30%', () => {
    const off = metrics({});
    const on = metrics({ latencyP50Ms: 8_000, totalCostUsd: 1 }); // only -20%
    expect(compareToRolloutBar(off, on).met).toBe(false);
  });

  it('fails when cost rises more than 25%', () => {
    const off = metrics({});
    const on = metrics({ latencyP50Ms: 5_000, totalCostUsd: 1.5 }); // +50% cost
    const v = compareToRolloutBar(off, on);
    expect(v.wallClockMet).toBe(true);
    expect(v.costMet).toBe(false);
    expect(v.met).toBe(false);
  });

  it('fails when the pass rate regresses', () => {
    const off = metrics({ successRate: 1 });
    const on = metrics({ successRate: 0.8, latencyP50Ms: 5_000, totalCostUsd: 1 });
    expect(compareToRolloutBar(off, on).passRateHeld).toBe(false);
  });

  it('a missing figure fails that part conservatively', () => {
    const off = metrics({ totalCostUsd: undefined });
    const on = metrics({ latencyP50Ms: 5_000, totalCostUsd: undefined });
    const v = compareToRolloutBar(off, on);
    expect(v.costMet).toBe(false);
    expect(v.costDelta).toBeUndefined();
    expect(v.met).toBe(false);
  });
});
