/**
 * A scannable summary at the end of an eval file's run — vitest's own
 * pass/fail dots say THAT something failed, not which fixture or why. Call
 * once per eval file from `afterAll`, with one entry per fixture.
 *
 * Also PERSISTS the results (lib/eval-store.ts → harness_eval_runs /
 * harness_eval_results, via the MCP server's execute_sql) so a run is
 * browsable at /evals instead of living only in this terminal's
 * scrollback. Best-effort: a persistence failure (no MCP_ENDPOINT_URL, an
 * endpoint that's down) is logged and swallowed, never thrown — the table
 * printed here is already the source of truth for whoever ran the command.
 */

import { saveEvalRun } from '@/lib/eval-store';
import type { EvalResultRecord, EvalSuite } from '@/lib/types';

export type EvalOutcome = EvalResultRecord;

export interface ReportOptions {
  suite: EvalSuite;
  label: string;
  /** What was graded — a model key, or the retrieval mode for the shortlist suite. */
  subject: string;
  judgeModel?: string;
  startedAt: Date;
  results: EvalOutcome[];
}

export async function report(opts: ReportOptions): Promise<void> {
  const { suite, label, subject, judgeModel, startedAt, results } = opts;
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total ? Math.round((passed / total) * 100) : 0;

  console.log(`\n=== ${label} eval [${subject}]: ${passed}/${total} (${rate}%) ===`);
  for (const r of results) {
    const extras = [
      r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : null,
      r.totalTokens != null ? `${r.totalTokens.toLocaleString()} tok` : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.fixtureId}${extras ? ` (${extras})` : ''}${r.notes ? ` — ${r.notes}` : ''}`
    );
  }
  console.log('');

  // Every fixture skipped (describe.skipIf) — nothing ran, nothing to record.
  if (total === 0) return;

  try {
    const id = await saveEvalRun({
      suite,
      subject,
      judgeModel,
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
