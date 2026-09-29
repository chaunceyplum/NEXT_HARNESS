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
import { isModelConfigured, judgeModelKey, trialsPerFixture, warnSkip } from './lib/env';

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
const trials = trialsPerFixture();
const configured = isModelConfigured(judgeKey);
if (!configured) warnSkip('judge calibration eval', `no credentials found for judge model "${judgeKey}".`);

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

describe.skipIf(!configured)(`Judge calibration eval (k=${trials})`, () => {
  const fixtures = loadFixtures<JudgeFixture>('judge-calibration');

  it.each(fixtures)('$id', async (fixture) => {
    const fixtureTrials: EvalTrialRecord[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const t0 = Date.now();
      let passed = false;
      let notes: string;
      try {
        const verdict = await judge(judgeKey, {
          task: fixture.task,
          criteria: allCriteria(fixture.criteria),
          answer: fixture.answer,
          toolActivity: fixture.toolActivity,
        });
        const judged = verdict.pass ? 'pass' : 'fail';
        passed = judged === fixture.humanVerdict;
        notes = passed ? '' : `human said ${fixture.humanVerdict}, judge said ${judged} — ${formatJudgeNotes(verdict)}`;
      } catch (err) {
        notes = `judge call failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      fixtureTrials.push({ fixtureId: fixture.id, trial, passed, notes, durationMs: Date.now() - t0 });
    }
    results.push(...fixtureTrials);
    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
