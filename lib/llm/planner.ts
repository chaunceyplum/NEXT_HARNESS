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

// NOTE: parallelWidth() does an exact O(2^n) antichain scan over the plan's
// steps, which is only affordable because this cap is small (8 → ≤256 subsets).
// If this cap ever rises, parallelWidth becomes a hot spot and needs a
// polynomial max-antichain algorithm instead.
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
  /**
   * The id of the worker that ran (or is running) this step in an
   * orchestrated run (lib/llm/coordinator.ts). Unset for single-agent runs and
   * for steps kept for synthesis. Set by the coordinator when it starts the
   * worker (Requirement 3.5).
   */
  workerId?: string;
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

/**
 * Renumber from 1 and start every step pending. A dependency on a step that
 * is dropped by the MAX_PLAN_STEPS cap is removed; a dependency on a step id
 * the plan never declared, or a set of dependencies that forms a cycle, is a
 * malformed plan and throws. The orchestration caller catches the throw and
 * falls back to running the plan single-agent (Req 3.6).
 */
export function normalisePlan(raw: z.infer<typeof planSchema>, version: number): Plan {
  const steps = raw.steps.slice(0, MAX_PLAN_STEPS);
  // Original id -> new (renumbered-from-1) id, for the steps that survive the cap.
  const idMap = new Map(steps.map((s, i) => [s.id, i + 1]));
  const plan: Plan = {
    goal: raw.goal,
    version,
    steps: steps.map((s, i) => ({
      id: i + 1,
      description: s.description,
      tool: s.tool,
      expectedOutput: s.expectedOutput,
      dependsOn: [
        ...new Set(
          s.dependsOn.map((d) => {
            const mapped = idMap.get(d);
            // The id was declared but trimmed by the cap: drop the dependency.
            if (mapped === undefined && raw.steps.some((o) => o.id === d)) return undefined;
            // The id was never declared at all: the plan is malformed.
            if (mapped === undefined) throw new Error(`Plan step ${i + 1} depends on unknown step ${d}.`);
            if (mapped === i + 1) throw new Error(`Plan step ${i + 1} depends on itself.`);
            return mapped;
          })
        ),
      ].filter((d): d is number => d !== undefined),
      status: 'pending' as const,
    })),
  };
  assertAcyclic(plan.steps);
  return plan;
}

/** Throw if the steps' dependsOn edges contain a cycle. */
function assertAcyclic(steps: PlanStep[]): void {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (id: number): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') throw new Error(`Plan has a dependency cycle involving step ${id}.`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    state.set(id, 'done');
  };
  for (const step of steps) visit(step.id);
}

/** Steps that are pending and whose dependencies are all done — ready to run now (Req 2.5, 3.3). */
export function readySteps(plan: Plan): PlanStep[] {
  const doneIds = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
  return plan.steps.filter((s) => s.status === 'pending' && s.dependsOn.every((d) => doneIds.has(d)));
}

/**
 * The largest number of steps that could ever run at the same time: the size
 * of the biggest antichain in the dependency DAG (steps with no path between
 * them). `shouldOrchestrate` uses it to decide whether orchestration can help.
 */
export function parallelWidth(plan: Plan): number {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  // reachable(a) = every step reachable from a by following dependsOn edges,
  // memoised. If b is reachable from a or a from b, they are ordered and can
  // never run together.
  const cache = new Map<number, Set<number>>();
  const reachable = (id: number): Set<number> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const out = new Set<number>();
    cache.set(id, out); // guard against cycles (normalisePlan rejects them anyway)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      out.add(dep);
      for (const r of reachable(dep)) out.add(r);
    }
    return out;
  };
  const ordered = (a: number, b: number): boolean => reachable(a).has(b) || reachable(b).has(a);
  // Greedy max antichain is exponential in general; plans are capped at
  // MAX_PLAN_STEPS, so a simple O(2^n) scan over subsets is fine and exact.
  const ids = plan.steps.map((s) => s.id);
  let best = 0;
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const subset: number[] = [];
    for (let i = 0; i < ids.length; i++) if (mask & (1 << i)) subset.push(ids[i]);
    if (subset.length <= best) continue;
    const independent = subset.every((a, i) => subset.every((b, j) => i >= j || !ordered(a, b)));
    if (independent) best = subset.length;
  }
  return best;
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

  /**
   * Replace every step that isn't done; completed steps are kept as history.
   *
   * The revised plan is renumbered from 1: the kept `done` steps keep ids
   * `1..kept.length`, and the new steps take the ids after them in order.
   * Each new step may declare the final renumbered ids it depends on. A
   * dependency on a kept done step or an earlier new step is kept; a
   * dependency on a step that no longer exists, on itself, or forward on a
   * later new step is dropped, so the plan stays acyclic (Req 6.4).
   */
  revise(
    reason: string,
    remaining: Array<{ description: string; tool: string | null; expectedOutput: string; dependsOn?: number[] }>
  ): { ok: boolean; message: string } {
    const kept = this.plan.steps.filter((s) => s.status === 'done');
    const room = MAX_PLAN_STEPS - kept.length;
    if (remaining.length > room) return { ok: false, message: `Too many steps: at most ${room} more (the plan is capped at ${MAX_PLAN_STEPS}).` };
    const total = kept.length + remaining.length;
    this.plan = {
      goal: this.plan.goal,
      version: this.plan.version + 1,
      steps: [
        ...kept,
        ...remaining.map((s, i) => {
          const selfId = kept.length + i + 1;
          const dependsOn = [
            ...new Set(
              (s.dependsOn ?? []).filter(
                // Keep references to an existing earlier step; drop unknown
                // ids, self and forward references.
                (d) => d >= 1 && d <= total && d < selfId
              )
            ),
          ];
          return {
            id: selfId,
            description: s.description,
            tool: s.tool,
            expectedOutput: s.expectedOutput,
            dependsOn,
            status: 'pending' as const,
            note: i === 0 ? `revised: ${reason.slice(0, 200)}` : undefined,
          };
        }),
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
      inputSchema: jsonSchema<{
        reason: string;
        steps: Array<{ description: string; tool: string | null; expectedOutput: string; dependsOn?: number[] }>;
      }>({
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
                dependsOn: {
                  type: 'array',
                  items: { type: 'integer' },
                  description:
                    'Ids of earlier steps whose results this step needs, numbered as in the revised plan: kept done steps first, then these new steps in order.',
                },
              },
              required: ['description', 'tool', 'expectedOutput'],
            },
          },
        },
        required: ['reason', 'steps'],
        additionalProperties: false,
      }),
      execute: async ({ reason, steps }) => tracker.revise(reason, steps),
      // steps[].dependsOn is optional; revise() remaps it to the renumbered plan.
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
