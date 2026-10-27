/**
 * A scannable summary at the end of an eval file's run — vitest's own
 * pass/fail dots say THAT something failed, not which fixture or why, and
 * say nothing about variance, cost, or latency. Call once per eval file from
 * `afterAll`, with one entry per fixture TRIAL.
 *
 * Also PERSISTS the results (lib/eval-store.ts → harness_eval_runs /
 * harness_eval_results, via the MCP server's execute_sql) so a run is
 * browsable at /evals. Best-effort: a persistence failure is logged and
 * swallowed, never thrown — the table printed here is already the source of
 * truth for whoever ran the command.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeRunMetrics, groupByFixture, type EvalRunMetrics } from '@/lib/eval-metrics';
import { saveEvalRun } from '@/lib/eval-store';
import type { EvalSuite, EvalTrialRecord } from '@/lib/types';

export interface ReportOptions {
  suite: EvalSuite;
  label: string;
  /** What was graded — a model key, or the retrieval mode for the shortlist suite. */
  subject: string;
  judgeModel?: string;
  promptVersion?: string;
  startedAt: Date;
  results: EvalTrialRecord[];
}

const pct = (x: number | undefined) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const secs = (ms: number | undefined) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);
const usd = (x: number | undefined) => (x == null ? 'n/a' : `$${x.toFixed(4)}`);
const num = (x: number | undefined) => (x == null ? 'n/a' : Math.round(x).toLocaleString());

export function formatMetrics(m: EvalRunMetrics): string[] {
  const lines = [
    `  success rate ${pct(m.successRate)} (n=${m.trials} trials, ${m.fixtures} fixtures × k=${m.k})`,
    `  pass@${m.k} ${pct(m.passAtK)} · pass^${m.k} ${pct(m.passHatK)}`,
  ];
  if (m.errored) lines.push(`  errored ${m.errored} trial(s) — grader/infrastructure failures, excluded from the rates above`);
  if (m.toolCallAccuracy != null) lines.push(`  tool-call accuracy ${pct(m.toolCallAccuracy)}`);
  lines.push(`  safety violations ${m.safetyViolations} (${pct(m.safetyViolationRate)} of trials)`);
  if (m.stepsMean != null) lines.push(`  steps to completion (mean) ${m.stepsMean.toFixed(1)}`);
  lines.push(`  latency p50 ${secs(m.latencyP50Ms)} · p95 ${secs(m.latencyP95Ms)}`);
  if (m.totalCostUsd != null || m.tokensPerSuccess != null) {
    lines.push(
      `  cost ${usd(m.totalCostUsd)} total · ${usd(m.costPerSuccessUsd)} per success` +
        (m.tokensPerSuccess != null ? ` · ${Math.round(m.tokensPerSuccess).toLocaleString()} tokens per success` : '')
    );
  }
  return lines;
}

export async function report(opts: ReportOptions): Promise<void> {
  const { suite, label, subject, judgeModel, promptVersion, startedAt, results } = opts;
  const metrics = computeRunMetrics(results);

  const meta = [subject, judgeModel ? `judge ${judgeModel}` : null, promptVersion ? `prompt ${promptVersion}` : null]
    .filter(Boolean)
    .join(', ');
  console.log(`\n=== ${label} eval [${meta}] ===`);
  for (const [fixtureId, trials] of groupByFixture(results)) {
    const graded = trials.filter((t) => !t.errored);
    const passed = graded.filter((t) => t.passed).length;
    const status =
      graded.length === 0 ? 'ERROR' : passed === graded.length ? 'PASS' : passed === 0 ? 'FAIL' : 'FLAKY';
    const unsafe = trials.some((t) => t.safetyViolation) ? ' ⚠ SAFETY' : '';
    const errs = trials.length - graded.length;
    console.log(`  ${status.padEnd(5)} ${fixtureId} (${passed}/${graded.length}${errs ? `, ${errs} errored` : ''})${unsafe}`);
    for (const t of trials) {
      if (t.passed && !t.notes) continue;
      const extras = [
        secs(t.durationMs),
        t.steps != null ? `${t.steps} steps` : null,
        t.totalTokens != null ? `${t.totalTokens.toLocaleString()} tok` : null,
        t.costUsd != null ? usd(t.costUsd) : null,
      ]
        .filter(Boolean)
        .join(', ');
      const verdict = t.errored ? 'ERROR' : t.passed ? 'pass' : 'fail';
      console.log(`      #${t.trial} ${verdict} (${extras})${t.notes ? ` — ${t.notes}` : ''}`);
    }
  }
  if (results.length) for (const line of formatMetrics(metrics)) console.log(line);
  console.log('');

  // Every fixture skipped (describe.skipIf) — nothing ran, nothing to record.
  if (results.length === 0) return;

  writeMetricsFile(suite, subject, promptVersion, metrics);

  try {
    const id = await saveEvalRun({
      suite,
      subject,
      judgeModel,
      promptVersion,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      results,
    });
    console.log(`[evals] Saved as eval run ${id} — view at /evals/${id}\n`);
  } catch (err) {
    console.error(
      `[evals] Could not save these results (${err instanceof Error ? err.message : String(err)}). ` +
        'The table above is still accurate — only the /evals history is affected.'
    );
  }
}

/**
 * The rollout bar from requirements.md ("Decisions taken for this spec"):
 * orchestration becomes the default only when it matches or beats single-agent
 * pass rate, with at least this much lower median wall-clock time and no more
 * than this much higher cost.
 */
export const ROLLOUT_BAR = { minWallClockReduction: 0.3, maxCostIncrease: 0.25 } as const;

export interface RolloutVerdict {
  /** Pass rate did not regress (orchestrated ≥ single-agent). */
  passRateHeld: boolean;
  /** Median wall-clock fell by at least the bar's minimum. */
  wallClockMet: boolean;
  /** Cost rose by no more than the bar's maximum. */
  costMet: boolean;
  /** All three — orchestration clears the rollout bar. */
  met: boolean;
  /** Fractional change off → on (negative = faster / cheaper). Undefined when a figure is missing. */
  wallClockDelta?: number;
  costDelta?: number;
}

/** Compare two modes against the rollout bar. A missing figure fails that part, conservatively. */
export function compareToRolloutBar(off: EvalRunMetrics, on: EvalRunMetrics): RolloutVerdict {
  const passRateHeld = on.successRate >= off.successRate;
  const frac = (from: number | undefined, to: number | undefined): number | undefined =>
    from == null || to == null || from === 0 ? undefined : (to - from) / from;
  const wallClockDelta = frac(off.latencyP50Ms, on.latencyP50Ms);
  const costDelta = frac(off.totalCostUsd, on.totalCostUsd);
  const wallClockMet = wallClockDelta != null && wallClockDelta <= -ROLLOUT_BAR.minWallClockReduction;
  const costMet = costDelta != null && costDelta <= ROLLOUT_BAR.maxCostIncrease;
  return {
    passRateHeld,
    wallClockMet,
    costMet,
    met: passRateHeld && wallClockMet && costMet,
    ...(wallClockDelta != null ? { wallClockDelta } : {}),
    ...(costDelta != null ? { costDelta } : {}),
  };
}

/**
 * Side-by-side report for an EVAL_ORCHESTRATE=both run (Requirement 16.2):
 * single-agent vs orchestrated pass rate, wall-clock, tokens and cost, then
 * whether orchestration clears the rollout bar. Printed and returned, so a
 * caller can also write it to a file. The per-mode `report()` calls still run;
 * this only adds the comparison.
 */
export function reportComparison(label: string, off: EvalTrialRecord[], on: EvalTrialRecord[]): string {
  const offM = computeRunMetrics(off);
  const onM = computeRunMetrics(on);
  const verdict = compareToRolloutBar(offM, onM);
  const delta = (d: number | undefined) => (d == null ? 'n/a' : `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`);
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  const rows: Array<[string, string, string]> = [
    ['pass rate', pct(offM.successRate), pct(onM.successRate)],
    [`pass^${offM.k}`, pct(offM.passHatK), pct(onM.passHatK)],
    ['median wall-clock', secs(offM.latencyP50Ms), secs(onM.latencyP50Ms)],
    ['p95 wall-clock', secs(offM.latencyP95Ms), secs(onM.latencyP95Ms)],
    ['total cost', usd(offM.totalCostUsd), usd(onM.totalCostUsd)],
    ['tokens / success', num(offM.tokensPerSuccess), num(onM.tokensPerSuccess)],
    ['safety violations', String(offM.safetyViolations), String(onM.safetyViolations)],
  ];
  const col1 = Math.max(...rows.map((r) => r[0].length), 'metric'.length);
  const col2 = Math.max(...rows.map((r) => r[1].length), 'single-agent'.length);
  const col3 = Math.max(...rows.map((r) => r[2].length), 'orchestrated'.length);
  const line = (a: string, b: string, c: string) => `  ${a.padEnd(col1)}  ${b.padStart(col2)}  ${c.padStart(col3)}`;
  const out: string[] = [];
  out.push(`\n=== ${label}: single-agent vs orchestrated (EVAL_ORCHESTRATE=both) ===`);
  out.push(line('metric', 'single-agent', 'orchestrated'));
  for (const [name, a, b] of rows) out.push(line(name, a, b));
  out.push('');
  out.push('  Rollout bar (requirements.md): orchestration becomes default only when it');
  out.push('  matches/beats pass rate, with ≥30% lower median wall-clock and ≤25% higher cost.');
  out.push(`    ${mark(verdict.passRateHeld)} pass rate held (${pct(offM.successRate)} → ${pct(onM.successRate)})`);
  out.push(`    ${mark(verdict.wallClockMet)} median wall-clock ${delta(verdict.wallClockDelta)} (need ≤ -30%)`);
  out.push(`    ${mark(verdict.costMet)} cost ${delta(verdict.costDelta)} (need ≤ +25%)`);
  out.push(`  ${verdict.met ? '✓ CLEARS the rollout bar' : '✗ does NOT clear the rollout bar — stays off by default'}`);
  out.push('');
  const text = out.join('\n');
  console.log(text);
  return text;
}

/**
 * EVAL_METRICS_DIR: also write this suite's metrics to <dir>/<suite>.json,
 * for scripts/check-eval-baseline.mjs (the CI regression gate) to compare
 * against evals/baseline.json.
 */
function writeMetricsFile(suite: EvalSuite, subject: string, promptVersion: string | undefined, metrics: EvalRunMetrics): void {
  const dir = process.env.EVAL_METRICS_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${suite}.json`), JSON.stringify({ suite, subject, promptVersion, metrics }, null, 2));
  } catch (err) {
    console.error(`[evals] Could not write metrics to ${dir}:`, err instanceof Error ? err.message : err);
  }
}
