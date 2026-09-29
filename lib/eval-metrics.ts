/**
 * Run-level eval metrics, computed from trial-level results. Pure, so the
 * CLI report (evals/lib/report.ts), the store (lib/eval-store.ts) and the
 * /evals pages all agree on one definition of each number.
 *
 * Each fixture can run several times (EVAL_TRIALS). With k trials per
 * fixture:
 *   - successRate: passed trials / all trials (the headline, with n).
 *   - passAtK: share of fixtures where at least one of k trials passed.
 *   - passHatK: share of fixtures where ALL k trials passed. This is
 *     production reliability, and it drops fast as k grows.
 *   - costPerSuccessUsd: total cost over successes, not over runs. A cheaper
 *     model that fails more can cost more.
 */

import type { EvalTrialRecord } from './types';

export interface EvalRunMetrics {
  fixtures: number;
  trials: number;
  /** Trials per fixture. The minimum across fixtures, if they ever differ. */
  k: number;
  successRate: number;
  passAtK: number;
  passHatK: number;
  /** Share of trials whose structural checks (tool choice, args, order, limits) passed. Undefined when no trial had them. */
  toolCallAccuracy?: number;
  /** Share of trials with at least one safety violation. Target is zero. */
  safetyViolationRate: number;
  safetyViolations: number;
  stepsMean?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  totalCostUsd?: number;
  costPerSuccessUsd?: number;
  tokensPerSuccess?: number;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

function defined<T>(values: Array<T | undefined>): T[] {
  return values.filter((v): v is T => v !== undefined && v !== null);
}

export function groupByFixture(trials: EvalTrialRecord[]): Map<string, EvalTrialRecord[]> {
  const groups = new Map<string, EvalTrialRecord[]>();
  for (const t of trials) {
    const list = groups.get(t.fixtureId) ?? [];
    list.push(t);
    groups.set(t.fixtureId, list);
  }
  return groups;
}

export function computeRunMetrics(trials: EvalTrialRecord[]): EvalRunMetrics {
  const groups = [...groupByFixture(trials).values()];
  const passed = trials.filter((t) => t.passed);
  const structural = defined(trials.map((t) => t.structuralPassed));
  const violations = trials.filter((t) => t.safetyViolation).length;
  const costs = defined(trials.map((t) => t.costUsd));
  const tokens = defined(trials.map((t) => t.totalTokens));
  const durations = defined(trials.map((t) => t.durationMs));

  // Only report a total/per-success cost when every trial was priced,
  // otherwise the figure silently undercounts.
  const totalCostUsd = costs.length === trials.length && trials.length ? costs.reduce((a, b) => a + b, 0) : undefined;
  const totalTokens = tokens.length === trials.length && trials.length ? tokens.reduce((a, b) => a + b, 0) : undefined;

  return {
    fixtures: groups.length,
    trials: trials.length,
    k: groups.length ? Math.min(...groups.map((g) => g.length)) : 0,
    successRate: trials.length ? passed.length / trials.length : 0,
    passAtK: groups.length ? groups.filter((g) => g.some((t) => t.passed)).length / groups.length : 0,
    passHatK: groups.length ? groups.filter((g) => g.every((t) => t.passed)).length / groups.length : 0,
    toolCallAccuracy: structural.length ? structural.filter(Boolean).length / structural.length : undefined,
    safetyViolationRate: trials.length ? violations / trials.length : 0,
    safetyViolations: violations,
    stepsMean: mean(defined(trials.map((t) => t.steps))),
    latencyP50Ms: percentile(durations, 50),
    latencyP95Ms: percentile(durations, 95),
    totalCostUsd,
    costPerSuccessUsd: totalCostUsd != null && passed.length ? totalCostUsd / passed.length : undefined,
    tokensPerSuccess: totalTokens != null && passed.length ? totalTokens / passed.length : undefined,
  };
}
