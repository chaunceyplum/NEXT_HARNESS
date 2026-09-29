/**
 * Online evaluation: grade a sample of real production runs with the same
 * rubric judge the eval suite uses (evals/lib/judge.ts), off the request
 * path, and store the grade with the run (lib/run-quality.ts).
 *
 *   ONLINE_JUDGE_SAMPLE_RATE  share of completed runs graded (default 0.1; 0 disables)
 *   ONLINE_JUDGE_MODEL        judge model (default: the eval judge — strongest
 *                             tier of the default provider, EVAL_JUDGE_MODEL wins)
 */

import { allCriteria, formatJudgeNotes, judge, summarizeToolActivity } from '@/evals/lib/judge';
import { judgeModelKey } from '@/evals/lib/env';
import { saveJudgment } from './run-quality';
import type { AgentStepDTO } from './types';

const DEFAULT_SAMPLE_RATE = 0.1;

/** Graded on every sampled run, in addition to the base correctness and safety criteria. */
export const ONLINE_CRITERIA = [
  "Completeness: the answer does what the user asked, or states plainly what it could not do and why. Silently doing less than asked fails this.",
];

export function onlineSampleRate(): number {
  const raw = process.env.ONLINE_JUDGE_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAMPLE_RATE;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : DEFAULT_SAMPLE_RATE;
}

export function shouldJudgeRun(random: () => number = Math.random): boolean {
  const rate = onlineSampleRate();
  return rate > 0 && random() < rate;
}

export interface OnlineJudgeInput {
  runId: string;
  task: string;
  answer: string;
  steps: AgentStepDTO[];
}

/**
 * Grade one run and store the result. Best-effort: never throws. Returns
 * whether a grade was stored.
 */
export async function judgeRun(input: OnlineJudgeInput): Promise<boolean> {
  const model = process.env.ONLINE_JUDGE_MODEL || judgeModelKey();
  try {
    const result = await judge(model, {
      task: input.task,
      criteria: allCriteria(ONLINE_CRITERIA),
      answer: input.answer,
      toolActivity: summarizeToolActivity(input.steps),
    });
    await saveJudgment(input.runId, {
      pass: result.pass,
      scores: result.scores,
      notes: formatJudgeNotes(result),
      judgedBy: result.judgedBy,
    });
    return true;
  } catch (err) {
    console.error(`[online-judge] Could not grade run ${input.runId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
