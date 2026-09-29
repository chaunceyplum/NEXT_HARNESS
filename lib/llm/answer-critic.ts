/**
 * Reflection / evaluator-optimizer on the final answer (§2.3, §3.5 grounding
 * check): after the loop, a critic checks the answer against the tool
 * results the run actually got. Every claim must trace to a tool result, the
 * request must be answered or a blocker stated, and anything claimed as done
 * must have succeeded. On failure the answer gets ONE revision (text only,
 * with the critic's issues), then a re-check; the run returns the revision
 * with a flag if it still fails. Hard cap, no loops.
 *
 *   CRITIC_MODE   off | flag (default: check and flag, never rewrite) | revise
 *   CRITIC_MODEL  model for the critic and the revision (default: the run's model)
 *
 * Runs only when the run used tools (there is nothing to ground otherwise)
 * and never on the eval path. A critic failure never fails the run.
 */

import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { resolveModel } from './model-registry';
import { summarizeToolActivity } from '@/evals/lib/judge';
import type { AgentStepTrace } from './agent-core';

export type CriticMode = 'off' | 'flag' | 'revise';

export function criticMode(): CriticMode {
  const v = process.env.CRITIC_MODE?.trim().toLowerCase();
  return v === 'off' || v === 'revise' ? v : 'flag';
}

const verdictSchema = z.object({
  grounded: z.boolean().describe('Every factual claim is supported by the tool activity (or is general knowledge that does not contradict it).'),
  answersRequest: z.boolean().describe('The answer does what was asked, or states plainly what blocked it.'),
  unsupportedClaims: z.array(z.string().max(200)).max(8).describe('Claims not supported by the tool activity, quoted briefly. Empty if none.'),
  issues: z.array(z.string().max(200)).max(8).describe('Specific problems to fix, one per entry. Empty if none.'),
});

export interface Critique {
  passed: boolean;
  grounded: boolean;
  answersRequest: boolean;
  unsupportedClaims: string[];
  issues: string[];
  /** The answer was rewritten once from the critic's issues. */
  revised: boolean;
  /** The first answer, kept when a revision replaced it. */
  originalAnswer?: string;
  model: string;
}

const CRITIC_SYSTEM = [
  "You check an AI agent's final answer against the tool calls and results it actually got.",
  'A claim is supported only if the tool activity shows it (or it is general knowledge that does not contradict it). Saying an action succeeded when its tool call errored or was not executed is unsupported.',
  'Judge only grounding and whether the request was answered or a blocker stated. Do not judge tone, length or style.',
].join('\n');

async function check(model: string, task: string, activity: string, answer: string) {
  const { object } = await generateObject({
    model: resolveModel(model),
    schema: verdictSchema,
    system: CRITIC_SYSTEM,
    prompt: `User request: ${task}\n\nTool activity:\n${activity || '(none)'}\n\nFinal answer to check:\n${answer || '(empty)'}`,
  });
  return object;
}

async function revise(model: string, task: string, activity: string, answer: string, issues: string[]): Promise<string> {
  const { text } = await generateText({
    model: resolveModel(model),
    system:
      "Rewrite an AI agent's final answer so every claim is supported by the tool activity shown. Keep what was right. Remove or correct unsupported claims, say plainly what failed or was not done, and do not add new facts. Output only the rewritten answer.",
    prompt: `User request: ${task}\n\nTool activity:\n${activity}\n\nAnswer to fix:\n${answer}\n\nProblems found:\n${issues.map((i) => `- ${i}`).join('\n')}`,
  });
  return text.trim();
}

/**
 * Check (and in revise mode, fix once) a run's final answer. Returns the
 * answer to use and the critique, or undefined when the critic is off, had
 * nothing to check, or failed.
 */
export async function critiqueAnswer(input: {
  task: string;
  answer: string;
  steps: AgentStepTrace[];
  modelKey: string;
  mode?: CriticMode;
}): Promise<{ answer: string; critique: Critique } | undefined> {
  const mode = input.mode ?? criticMode();
  if (mode === 'off') return undefined;
  if (!input.steps.some((s) => s.toolCalls.length > 0)) return undefined;
  const model = process.env.CRITIC_MODEL || input.modelKey;
  const activity = summarizeToolActivity(input.steps);

  try {
    const first = await check(model, input.task, activity, input.answer);
    const firstIssues = [...first.issues, ...first.unsupportedClaims.map((c) => `Unsupported: ${c}`)];
    const passed = first.grounded && first.answersRequest;
    if (passed || mode === 'flag') {
      return { answer: input.answer, critique: { passed, ...first, revised: false, model } };
    }

    const revisedAnswer = await revise(model, input.task, activity, input.answer, firstIssues);
    if (!revisedAnswer) return { answer: input.answer, critique: { passed: false, ...first, revised: false, model } };
    const second = await check(model, input.task, activity, revisedAnswer);
    return {
      answer: revisedAnswer,
      critique: {
        passed: second.grounded && second.answersRequest,
        ...second,
        revised: true,
        originalAnswer: input.answer,
        model,
      },
    };
  } catch (err) {
    console.error('[critic] Skipped:', err instanceof Error ? err.message : err);
    return undefined;
  }
}
