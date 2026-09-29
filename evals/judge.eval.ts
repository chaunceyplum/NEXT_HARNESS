/**
 * Eval-judge calibration — run manually with `npm run eval:judge`.
 *
 * The rubric judge (evals/lib/judge.ts) decides outcome grades for the agent
 * suite, so its grades are only as trustworthy as its agreement with a
 * human's. Each fixture here is a task, criteria, the tool activity the
 * agent saw, a candidate final answer, and the verdict a human reviewer gave
 * it. This suite reports how often the judge agrees.
 *
 * Re-run whenever the judge prompt or judge model changes. The guidance is
 * 50–100 labelled examples before trusting a judge; this set starts small
 * and deliberately includes the hard cases (confident but wrong, correct
 * but terse, injected instruction followed quietly). Grow it with real
 * answers from agent-eval runs a human has graded.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { EvalTrialRecord } from '@/lib/types';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
import { allCriteria, formatJudgeNotes, judge } from './lib/judge';
import { judgeFallbackModelKey, judgeModelKey, modelSource, preflight, trialsPerFixture, warnSkip } from './lib/env';

type JudgeFixture = {
  id: string;
  note?: string;
  task: string;
  criteria: string[];
  toolActivity?: string;
  answer: string;
  humanVerdict: 'pass' | 'fail';
};

const judgeKey = judgeModelKey();
const fallbackKey = judgeFallbackModelKey(judgeKey);
const trials = trialsPerFixture();
const pre = await preflight('judge calibration eval', [{ role: 'judge', key: judgeKey, source: modelSource('judge') }]);
if (pre.status === 'skip') warnSkip('judge calibration eval', pre.reason);
const preflightError = pre.status === 'fail' ? pre.reason : '';

const results: EvalTrialRecord[] = [];
const startedAt = new Date();
afterAll(() =>
  report({
    suite: 'judge_calibration',
    label: 'Eval judge vs human labels',
    subject: judgeKey,
    startedAt,
    results,
  })
);

describe.runIf(pre.status === 'fail')('Judge calibration eval preflight', () => {
  it('configured judge is reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`Judge calibration eval (k=${trials})`, () => {
  const fixtures = loadFixtures<JudgeFixture>('judge-calibration');

  it.each(fixtures)('$id', async (fixture) => {
    const fixtureTrials: EvalTrialRecord[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const t0 = Date.now();
      let passed = false;
      let errored = false;
      let notes: string;
      try {
        const verdict = await judge(
          judgeKey,
          { task: fixture.task, criteria: allCriteria(fixture.criteria), answer: fixture.answer, toolActivity: fixture.toolActivity },
          fallbackKey
        );
        const judged = verdict.pass ? 'pass' : 'fail';
        passed = judged === fixture.humanVerdict;
        const by = verdict.fallbackReason ? `judged by fallback ${verdict.judgedBy} (${verdict.fallbackReason})` : '';
        notes = passed ? by : `human said ${fixture.humanVerdict}, judge said ${judged} — ${formatJudgeNotes(verdict)}`;
      } catch (err) {
        // No verdict at all: the grader failed, not the calibration. Excluded from agreement.
        errored = true;
        notes = `no verdict: ${err instanceof Error ? err.message : String(err)}`;
      }
      fixtureTrials.push({ fixtureId: fixture.id, trial, passed, errored, notes, durationMs: Date.now() - t0 });
    }
    results.push(...fixtureTrials);
    // Errored trials still fail the test run (loudly) even though the metrics exclude them.
    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}${t.errored ? ' ERROR' : ''}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
