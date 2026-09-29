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
