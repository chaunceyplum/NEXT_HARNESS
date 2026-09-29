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
 * DEFAULT_MODEL). No MCP call is made.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { judgeRagResult } from '@/lib/llm/rag-judge';
import { getDefaultModelKey } from '@/lib/llm/model-registry';
import { loadFixtures } from './lib/fixtures';
import { report, type EvalOutcome } from './lib/report';
import { isModelConfigured, warnSkip } from './lib/env';
import { gradeRagJudgment, type RagJudgeExpectations } from './lib/grading';

type RagJudgeFixture = {
  id: string;
  note?: string;
  query: string;
  output: unknown;
  expected: RagJudgeExpectations;
};

const modelKey = process.env.RAG_JUDGE_MODEL || getDefaultModelKey();
const disabled = process.env.RAG_JUDGE_ENABLED === 'false';
const configured = !disabled && isModelConfigured(modelKey);
if (disabled) warnSkip('RAG-judge eval', 'RAG_JUDGE_ENABLED=false — the judge being graded is turned off.');
else if (!configured) warnSkip('RAG-judge eval', `no credentials found for judge model "${modelKey}".`);

const results: EvalOutcome[] = [];
const startedAt = new Date();
afterAll(() =>
  report({ suite: 'rag_judge', label: 'RAG judge calibration (judgeRagResult)', subject: modelKey, startedAt, results })
);

describe.skipIf(!configured)('RAG judge eval (judgeRagResult)', () => {
  const fixtures = loadFixtures<RagJudgeFixture>('rag-judge');

  it.each(fixtures)('$id', async (fixture) => {
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
    results.push({ fixtureId: fixture.id, passed, notes: notes.join('; '), durationMs: Date.now() - t0 });
    expect.soft(passed, notes.join('; ')).toBe(true);
  });
});
