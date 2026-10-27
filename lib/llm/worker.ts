/**
 * Phase 2 (orchestrator-workers): one worker runs a single plan step.
 *
 * A worker is a small, bounded agent loop. It reuses {@link executeLoop}
 * (the same loop single-agent runs use) with:
 *
 *   - a narrow tool set (workerTools): the step's tool, its platform-group
 *     siblings, find_tools, call_tool and report_result — never
 *     remember_fact / update_plan / revise_plan (Requirements 4.2, 4.3);
 *   - a first message built from the run goal, this step, the WorkerResults of
 *     the steps it depends on and the planning knowledge — no other worker's
 *     transcript (Requirements 4.4, 4.5);
 *   - WORKER_MAX_STEPS as its step cap and report_result forced on the last
 *     step (Requirements 4.1, 4.6);
 *   - a child budget sliced from the run ledger that also charges the ledger
 *     (Requirements 8.1, 8.2, 8.3);
 *   - a child AbortController linked to the run's, so the run's abort / kill
 *     switch aborts the worker (Requirement 9.3);
 *   - per-worker same-tier fallback that executeLoop already does, except a
 *     worker that has already written is failed instead of restarted
 *     (Requirements 10.1, 10.2, 10.3).
 *
 * A worker ends by calling report_result. If it ends without a valid one, the
 * step is failed with "worker ended without a result" (Requirement 4.7).
 */

import { tool, jsonSchema, type Tool, type ToolSet } from 'ai';
import type { AgentStepTrace, LoopContext, ToolApprovalFn, ToolOutcome } from './agent-core';
import type { ApprovalReason } from './approval-policy';
import type { LaunchValidationGate } from './launch-validation';
import type { ModelHealthTracker } from './model-health';
import { executeLoop } from './agent';
import { getDefaultModelKey } from './model-registry';
import { PLATFORM_GROUPS, toolMatchesPlatforms, type McpToolDefinition } from './tool-catalog';
import type { PlanStep } from './planner';
import type { RunLedger } from './run-budget';
import { workerBudgetShare } from './orchestration-config';

// ── Worker result / record types ───────────────────────────────────────────────
// Re-homed to lib/types.ts in Task 8.1 (the record/resume phase) so the run
// record, stream events and resume path share one definition. Re-exported here
// so existing importers (coordinator, tests) keep importing them from worker.ts.
// WorkerRecord.steps is typed AgentStepDTO[] there; AgentStepTrace is
// structurally identical, so the runtime steps assign without a cast.
export type { WorkerStatus, WorkerResult, WorkerRecord } from '../types';
import type { WorkerResult, WorkerRecord, WorkerStatus } from '../types';

/** Caps from Requirement 5.2. report_result truncates to these before reporting. */
export const MAX_SUMMARY_CHARS = 1_000;
export const MAX_NOTES_CHARS = 500;

/** Name of the tool a worker loop is forced to end on (Requirement 4.6). */
export const REPORT_RESULT_TOOL = 'report_result';

/**
 * report_result (Requirements 5.1, 5.2): the only way a worker reports back.
 * The step id is bound by the caller (the worker knows its own step), so the
 * model only supplies status, summary, ids and optional notes. `summary` is
 * truncated to 1,000 and `notes` to 500 characters before the result is
 * handed to `sink` — the cap is enforced in code, not asked of the model.
 *
 * `sink` is called once per successful call; the coordinator reads the last
 * reported result (a model that calls it twice has the later call win).
 */
export function reportResultTool(stepId: number, sink: (result: WorkerResult) => void): Tool {
  return tool({
    description:
      'Report the outcome of this step and finish. Call exactly once, when the step is done or cannot be done. ' +
      'Put the ids a later step will need (e.g. the new data element id) in `ids`, a one-line outcome in `summary`, ' +
      'and anything a dependent step should know in `notes`.',
    inputSchema: jsonSchema<{
      status: 'done' | 'failed';
      summary: string;
      ids?: Record<string, string>;
      notes?: string;
    }>({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'failed'] },
        summary: { type: 'string', description: 'One-line outcome of the step.' },
        ids: {
          type: 'object',
          description: 'Identifiers a dependent step needs, e.g. { "dataElementId": "DE123" }.',
          additionalProperties: { type: 'string' },
        },
        notes: { type: 'string', description: 'Optional extra context for dependent steps.' },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    }),
    execute: async ({ status, summary, ids, notes }) => {
      const result: WorkerResult = {
        stepId,
        status,
        summary: String(summary ?? '').slice(0, MAX_SUMMARY_CHARS),
        ids: normaliseIds(ids),
        ...(notes ? { notes: String(notes).slice(0, MAX_NOTES_CHARS) } : {}),
      };
      sink(result);
      return { ok: true, message: `Result recorded (${status}).` };
    },
  });
}

/** Keep only string id values; a model occasionally returns a nested object or number. */
function normaliseIds(ids: Record<string, string> | undefined): Record<string, string> {
  if (!ids || typeof ids !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

// ── Tool narrowing ──────────────────────────────────────────────────────────────

/** Tools a worker is never given, whatever its step (Requirement 4.3). */
const EXCLUDED_WORKER_TOOLS = new Set(['remember_fact', 'update_plan', 'revise_plan']);

/** Always kept (when present in the run's tool set) so a worker can discover and call tools it wasn't handed directly. */
const WORKER_KEEP_TOOLS = new Set(['find_tools', 'call_tool']);

/** The PLATFORM_GROUPS group names a tool belongs to (usually one; some tools match none). */
function platformsOf(toolName: string): string[] {
  return Object.keys(PLATFORM_GROUPS).filter((group) => toolMatchesPlatforms(toolName, [group]));
}

/**
 * Narrow the run's policy-filtered tool set to just what this step needs
 * (Requirement 4.2): the step's tool, every tool in the same PLATFORM_GROUPS
 * group that the run already allows, find_tools, call_tool and report_result.
 * remember_fact / update_plan / revise_plan are always excluded. Grouping by
 * platform keeps the number of distinct worker tool sets (and so prompt-cache
 * prefixes) per run small.
 *
 * `catalog` scopes the platform-group expansion to real catalog tools, so the
 * synthetic local tools (find_tools, call_tool, report_result, policy_info)
 * are only added by the explicit rules below and never pulled in as accidental
 * "group siblings".
 */
export function workerTools(all: ToolSet, step: PlanStep, catalog: McpToolDefinition[]): ToolSet {
  const out: ToolSet = {};
  const catalogNames = new Set(catalog.map((t) => t.name));
  const keep = (name: string): void => {
    if (name in all && !EXCLUDED_WORKER_TOOLS.has(name)) out[name] = all[name];
  };

  // The step's own tool, plus its platform-group siblings that both the run
  // allows and the catalog actually defines.
  if (step.tool) {
    keep(step.tool);
    const groups = platformsOf(step.tool);
    for (const name of Object.keys(all)) {
      if (catalogNames.has(name) && platformsOf(name).some((g) => groups.includes(g))) keep(name);
    }
  }
  // Discovery tools, so a worker whose step tool is null (or mis-named) can
  // still find and run what it needs.
  for (const name of WORKER_KEEP_TOOLS) keep(name);

  return out;
}

// ── runWorker ────────────────────────────────────────────────────────────────────

/**
 * State one orchestrated run shares across every worker. The coordinator
 * builds it once and hands the same instance to each worker.
 */
export interface SharedRunState {
  runId?: string;
  /** The run's budget ledger; each worker gets a child slice that also charges it. */
  ledger: RunLedger;
  /** One LaunchValidationGate per run, shared by every worker (Requirement 9.1). */
  launchGate?: LaunchValidationGate;
  /** The run's abort signal; each worker links a child controller to it (Requirement 9.3). */
  abortSignal?: AbortSignal;
  /** Health tracker, shared so a model that fails in one worker is routed around in the next. */
  modelHealth: ModelHealthTracker;
  /**
   * The run's approval gate, built once by the coordinator (Task 7.2 wires it
   * through); passed straight to the worker's loop so worker tool calls are
   * gated exactly as single-agent ones. Omit to bypass gating (eval path).
   */
  toolApproval?: ToolApprovalFn;
  /** Approval reason per tool-call id, shared with toolApproval. */
  approvalReasons?: Map<string, ApprovalReason>;
  /** Base tracer attributes for the run; worker spans extend these. */
  baseTracerAttrs?: Record<string, import('../tracing').AttrValue>;
  /**
   * The coordinator span each worker's trace nests under, so the run's spans
   * form one tree — coordinator → worker → step (Requirement 14.1). Unset when
   * the run is untraced (the eval path).
   */
  tracerParent?: import('../tracing').SpanRef;
}

export interface WorkerInput {
  /** The id the coordinator gave this worker; defaults to `${runId}:w${stepId}:${attempt}`. */
  workerId?: string;
  runGoal: string;
  step: PlanStep;
  /** The WorkerResults of the steps this step depends on (Requirement 4.4). */
  deps: WorkerResult[];
  /**
   * Reasoning steps (`tool: null`) this step depends on, directly or through
   * other reasoning steps. They get no worker of their own; their work is
   * folded into this step's brief so it is done here.
   */
  folded?: PlanStep[];
  /** Planning knowledge excerpts (planningRetrieval.context), if any. */
  knowledge?: string;
  /** The run's policy-filtered tool set, narrowed per step by workerTools. */
  tools: ToolSet;
  /** The full catalog, forwarded to workerTools. */
  catalog: McpToolDefinition[];
  /** Model the worker runs on (WORKER_MODEL or the run's model). */
  modelKey: string;
  /** Whether `modelKey` was pinned (a request model, not routed) — disables fallback. */
  isPinned?: boolean;
  /** Step cap for this worker (WORKER_MAX_STEPS). */
  maxSteps: number;
  shared: SharedRunState;
  /** 1-based attempt number; a restart increments it. */
  attempt: number;
  /** Extended-thinking budget, if the run requested one. */
  thinkingBudget?: number;
  onStep?: (step: AgentStepTrace) => void;
  onToolOutcome?: (outcome: ToolOutcome) => void;
  onRestart?: (info: { fromModelKey: string; toModelKey: string }) => void;
}

/**
 * Build a worker's first user message (Requirements 4.4, 4.5): the run goal,
 * this step, the results of the steps it depends on, and the planning
 * knowledge. No other worker's transcript appears here.
 */
export function buildWorkerBrief(input: Pick<WorkerInput, 'runGoal' | 'step' | 'deps' | 'knowledge' | 'folded'>): string {
  const { runGoal, step, deps, knowledge, folded } = input;
  const lines = [
    'You are carrying out ONE step of a larger plan. Do only this step.',
    '',
    `Goal of the whole run: ${runGoal}`,
    `Your step: ${step.description}`,
    `Tool to use: ${step.tool ?? '(none — reason and report)'}`,
    `Done when: ${step.expectedOutput}`,
  ];

  if (folded?.length) {
    lines.push('', 'Before your step, do this reasoning yourself (these steps have no worker of their own):');
    for (const f of folded) lines.push(`- Step ${f.id}: ${f.description} → ${f.expectedOutput}`);
  }

  if (deps.length) {
    lines.push('', 'Results from earlier steps:');
    for (const dep of deps) {
      const ids = Object.keys(dep.ids).length ? ` ids=${JSON.stringify(dep.ids)}` : '';
      lines.push(`- Step ${dep.stepId} [${dep.status}]: ${dep.summary}${ids}${dep.notes ? ` (${dep.notes})` : ''}`);
    }
  }

  if (knowledge && knowledge.trim()) {
    lines.push('', knowledge.trim());
  }

  lines.push(
    '',
    `When the step is done, or cannot be done, call ${REPORT_RESULT_TOOL} with status, a one-line summary, and any ids a later step needs.`
  );
  return lines.join('\n');
}

/**
 * Run one worker to completion and return its record.
 *
 * - A child AbortController is linked to the run's signal, so a run abort /
 *   kill-switch trip aborts the worker (Requirement 9.3).
 * - The child budget is sliced from the run ledger at WORKER_BUDGET_SHARE of
 *   what remains; every step charges the ledger too (Requirements 8.1–8.3).
 * - report_result is forced on the last allowed step (Requirement 4.6).
 * - executeLoop does the per-worker same-tier fallback, and refuses to
 *   restart an attempt that already wrote (Requirements 10.1, 10.2); a
 *   restart fires onRestart with the worker id (Requirement 10.3).
 * - A worker that never produced a valid report_result is failed with
 *   "worker ended without a result" (Requirement 4.7).
 */
export async function runWorker(input: WorkerInput): Promise<WorkerRecord> {
  const { step, shared, attempt } = input;
  const workerId = input.workerId ?? `${shared.runId ?? 'run'}:w${step.id}:${attempt}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // Requirement 9.3: child controller that aborts when the run's does. If the
  // run is already aborted, the child starts aborted too.
  const controller = new AbortController();
  const runSignal = shared.abortSignal;
  const onRunAbort = () => controller.abort(runSignal?.reason);
  if (runSignal) {
    if (runSignal.aborted) controller.abort(runSignal.reason);
    else runSignal.addEventListener('abort', onRunAbort, { once: true });
  }

  // Requirements 8.1–8.3: a child budget sliced from the ledger's remaining
  // tokens/cost at WORKER_BUDGET_SHARE, charging the ledger on every step. The
  // child tracker is rebuilt by executeLoop per model attempt from these
  // limits + the ledger, so a fallback keeps the same slice and keeps charging.
  const budgetLimits = shared.ledger.childLimits(workerBudgetShare());

  // report_result records the last result it sees; the coordinator reads it
  // after the loop (Requirement 4.7 handles the no-result case).
  let reported: WorkerResult | undefined;
  // Requirement 10.3: a same-tier restart is a new attempt. The workerId stays
  // the same (it names the lane), but the record and the restarted attempt's
  // trace carry the bumped attempt number.
  let currentAttempt = attempt;
  const tracerAttrs: Record<string, import('../tracing').AttrValue> = {
    ...(shared.baseTracerAttrs ?? {}),
    'harness.worker.id': workerId,
    'harness.worker.step_id': step.id,
    'harness.worker.attempt': attempt,
  };
  const onRestart = (info: { fromModelKey: string; toModelKey: string }): void => {
    currentAttempt += 1;
    // executeLoop builds the next attempt's tracer from this same object.
    tracerAttrs['harness.worker.attempt'] = currentAttempt;
    input.onRestart?.(info);
  };

  const narrowed = workerTools(input.tools, step, input.catalog);
  const tools: ToolSet = {
    ...narrowed,
    [REPORT_RESULT_TOOL]: reportResultTool(step.id, (r) => {
      reported = r;
    }),
  };

  const ctx: LoopContext = {
    tools,
    launchMode: Boolean(shared.launchGate),
    publishEnabled: false,
    userMessage: buildWorkerBrief(input),
    startModelKey: input.modelKey || getDefaultModelKey(),
    isPinned: Boolean(input.isPinned),
    maxSteps: input.maxSteps,
    budgetLimits,
    budgetParent: shared.ledger,
    modelHealth: shared.modelHealth,
    forceFinalTool: REPORT_RESULT_TOOL,
    approvalReasons: shared.approvalReasons ?? new Map<string, ApprovalReason>(),
    baseTracerAttrs: tracerAttrs,
    // Requirement 14.1: nest the worker's trace under the coordinator span.
    ...(shared.tracerParent ? { tracerParent: shared.tracerParent } : {}),
    ...(shared.launchGate ? { launchGate: shared.launchGate } : {}),
    // Tag each approval with this worker so the request names it (Requirements 11.3, 15.3).
    ...(shared.toolApproval
      ? { toolApproval: ((approval) => shared.toolApproval!({ ...approval, workerId })) as ToolApprovalFn }
      : {}),
    ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
    abortSignal: controller.signal,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    ...(input.onToolOutcome ? { onToolOutcome: input.onToolOutcome } : {}),
    onRestart,
  };

  try {
    const loop = await executeLoop(ctx);

    // Requirement 4.7: a worker that ends without a valid report_result is a
    // failed step, whatever text it produced.
    if (!reported) {
      return {
        workerId,
        stepId: step.id,
        attempt: currentAttempt,
        modelKey: loop.modelKey,
        status: 'failed',
        steps: loop.steps,
        budgetUsage: loop.budgetUsage,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        error: 'worker ended without a result',
      };
    }

    // The model's own report_result status decides done vs failed (Req 5.3, 5.4).
    const status: WorkerStatus = reported.status === 'done' ? 'done' : 'failed';
    return {
      workerId,
      stepId: step.id,
      attempt: currentAttempt,
      modelKey: loop.modelKey,
      status,
      steps: loop.steps,
      result: reported,
      budgetUsage: loop.budgetUsage,
      startedAt,
      durationMs: Date.now() - startedAtMs,
      ...(status === 'failed' ? { error: reported.summary } : {}),
    };
  } catch (err) {
    // Requirements 10.1/10.2 are enforced inside executeLoop (it refuses to
    // restart an attempt that already wrote and rethrows). Anything that
    // reaches here — a provider failure with no healthy fallback, a
    // post-write failure, an abort, or any other throw — fails the step
    // (Requirements 4.7, 5.4, 9.4).
    const message = err instanceof Error ? err.message : String(err);
    return {
      workerId,
      stepId: step.id,
      attempt: currentAttempt,
      modelKey: input.modelKey,
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      steps: [],
      // The ledger has been charged for whatever the attempt(s) spent; report
      // the run-level usage so a failed worker's spend is still accounted for.
      budgetUsage: shared.ledger.usage(),
      startedAt,
      durationMs: Date.now() - startedAtMs,
      error: message,
    };
  } finally {
    if (runSignal) runSignal.removeEventListener('abort', onRunAbort);
  }
}
