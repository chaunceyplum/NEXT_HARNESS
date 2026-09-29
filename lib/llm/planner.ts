/**
 * Plan-and-execute (§2.2): for multi-step work, decompose the request into
 * a plan (data, not a paragraph), optionally show it to a person before
 * anything runs, then execute it with the normal tool loop while the model
 * keeps each step's status up to date. When a step fails or reveals new
 * information, the model revises the remaining steps.
 *
 * Opt-in per request (planFirst: true) or for every run (PLAN_FIRST=true).
 * The plan is capped at MAX_STEPS short steps, each naming the tool it
 * expects to use and a checkable expected output, which is the guide's fix
 * for over-planning and vague steps.
 */

import { generateObject, jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolveModel } from './model-registry';

export const MAX_PLAN_STEPS = 8;

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: number;
  description: string;
  /** The tool the step expects to call, or null for a reasoning/answer step. */
  tool: string | null;
  expectedOutput: string;
  dependsOn: number[];
  status: PlanStepStatus;
  note?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** Incremented on every revision. */
  version: number;
}

export function planFirstByDefault(): boolean {
  return process.env.PLAN_FIRST?.trim().toLowerCase() === 'true';
}

const planSchema = z.object({
  goal: z.string().max(300).describe('The outcome the user wants, in one sentence.'),
  steps: z
    .array(
      z.object({
        id: z.number().int().describe('1, 2, 3… in execution order.'),
        description: z.string().max(200).describe('One concrete action.'),
        tool: z.string().nullable().describe('The exact tool name this step will call, or null for a step that only reasons or writes the answer.'),
        expectedOutput: z.string().max(200).describe('What will show the step succeeded, e.g. "the new segment id".'),
        dependsOn: z.array(z.number().int()).describe('Ids of earlier steps whose results this step needs.'),
      })
    )
    .min(1)
    .max(MAX_PLAN_STEPS),
});

/** Ask the model for the minimum plan that achieves the request, using only the tools it can call. */
export async function makePlan(request: string, toolNames: string[], modelKey: string, context?: string): Promise<Plan> {
  const { object } = await generateObject({
    model: resolveModel(modelKey),
    schema: planSchema,
    system: [
      'You plan work for a MarTech engineering agent. Produce the MINIMUM ordered plan that achieves the request: a three-step job gets three steps, not eight.',
      `Every step must name the exact tool it will call (from the list given) or null, and a concrete, checkable expected output. At most ${MAX_PLAN_STEPS} steps.`,
      'Read before you change: look up anything whose current state matters before a step that modifies it.',
      'Do not plan anything the user did not ask for.',
    ].join('\n'),
    prompt: `Request: ${request}\n\n${context ? `${context}\n\n` : ''}Tools available: ${toolNames.join(', ')}`,
  });
  return normalisePlan(object, 1);
}

/** Renumber from 1, drop dangling dependencies, and start every step pending. */
export function normalisePlan(raw: z.infer<typeof planSchema>, version: number): Plan {
  const idMap = new Map(raw.steps.map((s, i) => [s.id, i + 1]));
  return {
    goal: raw.goal,
    version,
    steps: raw.steps.slice(0, MAX_PLAN_STEPS).map((s, i) => ({
      id: i + 1,
      description: s.description,
      tool: s.tool,
      expectedOutput: s.expectedOutput,
      dependsOn: s.dependsOn.map((d) => idMap.get(d)).filter((d): d is number => d !== undefined && d < i + 1),
      status: 'pending' as const,
    })),
  };
}

export function formatPlan(plan: Plan): string {
  return [
    `Goal: ${plan.goal}`,
    ...plan.steps.map(
      (s) =>
        `${s.id}. [${s.status}] ${s.description}${s.tool ? ` (tool: ${s.tool})` : ''} → expect: ${s.expectedOutput}` +
        (s.dependsOn.length ? ` (needs ${s.dependsOn.join(', ')})` : '')
    ),
  ].join('\n');
}

/** The run's plan, updated by the model through update_plan / revise_plan. */
export class PlanTracker {
  constructor(
    public plan: Plan,
    private readonly onChange?: (plan: Plan) => void
  ) {}

  update(stepId: number, status: PlanStepStatus, note?: string): { ok: boolean; message: string } {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, message: `No step ${stepId}. Steps are 1-${this.plan.steps.length}.` };
    step.status = status;
    if (note) step.note = note.slice(0, 300);
    this.onChange?.(this.plan);
    return { ok: true, message: `Step ${stepId} is now ${status}.` };
  }

  /** Replace every step that isn't done; completed steps are kept as history. */
  revise(reason: string, remaining: Array<{ description: string; tool: string | null; expectedOutput: string }>): { ok: boolean; message: string } {
    const kept = this.plan.steps.filter((s) => s.status === 'done');
    const room = MAX_PLAN_STEPS - kept.length;
    if (remaining.length > room) return { ok: false, message: `Too many steps: at most ${room} more (the plan is capped at ${MAX_PLAN_STEPS}).` };
    this.plan = {
      goal: this.plan.goal,
      version: this.plan.version + 1,
      steps: [
        ...kept,
        ...remaining.map((s, i) => ({ id: kept.length + i + 1, ...s, dependsOn: [], status: 'pending' as const, note: i === 0 ? `revised: ${reason.slice(0, 200)}` : undefined })),
      ],
    };
    this.onChange?.(this.plan);
    return { ok: true, message: `Plan revised (v${this.plan.version}):\n${formatPlan(this.plan)}` };
  }
}

/** update_plan and revise_plan: synthetic, local, read-classified tools the executor calls to keep the plan current. */
export function buildPlanTools(tracker: PlanTracker): ToolSet {
  return {
    update_plan: tool({
      description:
        "Record progress on the current plan: mark a step running when you start it, done when its expected output is in hand, failed if it can't succeed, or skipped. Include a short note with ids or the reason.",
      inputSchema: jsonSchema<{ stepId: number; status: PlanStepStatus; note?: string }>({
        type: 'object',
        properties: {
          stepId: { type: 'integer' },
          status: { type: 'string', enum: ['running', 'done', 'failed', 'skipped'] },
          note: { type: 'string' },
        },
        required: ['stepId', 'status'],
        additionalProperties: false,
      }),
      execute: async ({ stepId, status, note }) => tracker.update(stepId, status, note),
    }),
    revise_plan: tool({
      description:
        'Replace the remaining (not done) steps when a step failed or its result changes what should happen next. Keep it minimal; each step names its tool and expected output.',
      inputSchema: jsonSchema<{ reason: string; steps: Array<{ description: string; tool: string | null; expectedOutput: string }> }>({
        type: 'object',
        properties: {
          reason: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                tool: { type: ['string', 'null'] },
                expectedOutput: { type: 'string' },
              },
              required: ['description', 'tool', 'expectedOutput'],
            },
          },
        },
        required: ['reason', 'steps'],
        additionalProperties: false,
      }),
      execute: async ({ reason, steps }) => tracker.revise(reason, steps),
    }),
  };
}

/** Instructions + the plan, prepended to the user's request for the executor. */
export function planPreamble(plan: Plan): string {
  return [
    'Execute this plan for the request below. Call update_plan as you start and finish each step.',
    'If a step fails or its result changes what should happen next, call revise_plan instead of improvising, then continue.',
    'When every step is done (or the rest cannot be done), write your final answer.',
    '',
    formatPlan(plan),
  ].join('\n');
}
