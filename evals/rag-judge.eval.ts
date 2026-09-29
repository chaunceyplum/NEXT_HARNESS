/**
 * RAG-judge calibration eval — run manually with `npm run eval:rag-judge`.
 *
 * lib/llm/rag-judge.ts scores every search_adobe_knowledge lookup in
 * production, and that score is only worth attaching if it agrees with a
 * human's read of the same retrieval. Each fixture is a query plus a canned
 * (hand-picked) retrieval result, and the band of judgments a careful
 * reviewer would accept — so this measures the judge's calibration, not the
 * knowledge base's retrieval (that's live and changes under you; a canned
 * result doesn't).
 *
 * Uses the same model the production judge would (RAG_JUDGE_MODEL, else
 * DEFAULT_MODEL). No MCP call is made. EVAL_TRIALS repeats each fixture, to
 * see whether the judge is stable on the same input.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { judgeRagResult } from '@/lib/llm/rag-judge';
import { getDefaultModelKey } from '@/lib/llm/model-registry';
import type { EvalTrialRecord } from '@/lib/types';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
import { modelSource, preflight, trialsPerFixture, warnSkip } from './lib/env';
import { gradeRagJudgment, type RagJudgeExpectations } from './lib/grading';

type RagJudgeFixture = {
  id: string;
  note?: string;
  query: string;
  output: unknown;
  expected: RagJudgeExpectations;
};

const modelKey = process.env.RAG_JUDGE_MODEL || getDefaultModelKey();
const trials = trialsPerFixture();
const disabled = process.env.RAG_JUDGE_ENABLED === 'false';
const pre = disabled
  ? ({ status: 'skip', reason: 'RAG_JUDGE_ENABLED=false — the judge being graded is turned off.' } as const)
  : await preflight('RAG-judge eval', [{ role: 'RAG judge', key: modelKey, source: modelSource('rag-judge') }]);
if (pre.status === 'skip') warnSkip('RAG-judge eval', pre.reason);
const preflightError = pre.status === 'fail' ? pre.reason : '';

const results: EvalTrialRecord[] = [];
const startedAt = new Date();
afterAll(() =>
  report({ suite: 'rag_judge', label: 'RAG judge calibration (judgeRagResult)', subject: modelKey, startedAt, results })
);

describe.runIf(pre.status === 'fail')('RAG judge eval preflight', () => {
  it('configured model is reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`RAG judge eval (judgeRagResult, k=${trials})`, () => {
  const fixtures = loadFixtures<RagJudgeFixture>('rag-judge');

  it.each(fixtures)('$id', async (fixture) => {
    const fixtureTrials: EvalTrialRecord[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const t0 = Date.now();
      const notes: string[] = [];
      // judgeRagResult never throws (by design, so it can't fail a real RAG
      // call) — undefined is how a model/credential failure shows up here.
      const judgment = await judgeRagResult(fixture.query, fixture.output);
      if (!judgment) {
        notes.push('judge returned no judgment (model call failed — see the [rag-judge] warning above)');
      } else {
        notes.push(...gradeRagJudgment(judgment, fixture.expected));
        if (notes.length) notes.push(`got relevance=${judgment.relevance} sufficient=${judgment.sufficient}: ${judgment.rationale}`);
      }
      const passed = Boolean(judgment) && notes.length === 0;
      fixtureTrials.push({
        fixtureId: fixture.id,
        trial,
        passed,
        structuralPassed: passed,
        notes: notes.join('; '),
        durationMs: Date.now() - t0,
      });
    }
    results.push(...fixtureTrials);
    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
