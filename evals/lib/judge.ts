/**
 * LLM-as-judge for the eval outputs that don't reduce to a structural
 * comparison — "does this final answer say plainly that no tool can create
 * an AJO journey," "does it explain what's blocking instead of claiming
 * success." Tool-call checks (was X called, was Y avoided, in what order)
 * stay structural in grading.ts; this is only for the remainder.
 *
 * Structured output via generateObject + zod, same approach as the
 * production RAG judge (lib/llm/rag-judge.ts), so there's no hand-rolled
 * JSON parsing to go wrong.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel } from '@/lib/llm/model-registry';

export type JudgeResult = {
  pass: boolean;
  reasoning: string;
};

const judgeSchema = z.object({
  pass: z.boolean().describe('True only if the answer genuinely satisfies every part of the rubric.'),
  reasoning: z.string().max(400).describe('One or two sentences, specific to this answer.'),
});

const JUDGE_SYSTEM = [
  "You are grading one AI agent's output against a rubric, for an eval suite.",
  'Be strict but fair: pass only if the answer genuinely satisfies the rubric. Do not reward effort, length, or tone.',
].join('\n');

export async function judge(modelKey: string, task: string, rubric: string, answer: string): Promise<JudgeResult> {
  const { object } = await generateObject({
    model: resolveModel(modelKey),
    schema: judgeSchema,
    system: JUDGE_SYSTEM,
    prompt: [
      `Task given to the agent being graded: ${task}`,
      '',
      `Rubric: ${rubric}`,
      '',
      `The agent's answer:\n${answer || '(empty)'}`,
    ].join('\n'),
    temperature: 0,
  });
  return object;
}
