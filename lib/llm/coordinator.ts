/**
 * Phase 2 (orchestrator-workers): the coordinator.
 *
 * When orchestration is on and a plan has two or more steps that could run at
 * the same time, the coordinator runs the plan instead of handing it to a
 * single agent loop. It is deterministic code, not an LLM loop
 * (requirements.md "Decisions taken for this spec"): it schedules ready steps
 * as concurrent workers (lib/llm/worker.ts), passes each finished worker's
 * WorkerResult to the steps that depend on it, replans after a failure, and
 * ends with one synthesis call that writes the final answer.
 *
 * What lives here:
 *   - orchestrationConfig / shouldOrchestrate (Requirements 2.2–2.5): the
 *     config a run resolves once, and the gate that decides single-agent vs
 *     coordinator;
 *   - the scheduler loop (Requirements 3.1–3.5, 3.7, 5.3, 5.4): ready steps up
 *     to maxWorkers, serial write workers in Launch runs, step status +
 *     workerId, results fanned out to dependants;
 *   - replanning after a failure (Requirements 6.1–6.3): wait for running
 *     workers, one revise call, MAX_REPLANS cap, skip the rest on the cap or a
 *     replan failure;
 *   - synthesis (Requirements 7.1, 7.2): one streamed call, with a plain list
 *     of step summaries as the fallback when the call fails;
 *   - stopping on ledger exhaustion and on abort (Requirements 8.4, 9.4).
 *
 * The critic, the online judge and the stored run record stay in the job
 * wrapper (lib/build-run.ts), exactly as for single-agent runs — the
 * coordinator only produces the AgentRunResult those steps already consume
 * (Requirement 7.3 is wired in Task 8.6).
 */

import { generateObject, streamText, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentRunResult } from './agent';
import type { AgentStepTrace, ToolApprovalFn, ToolOutcome } from './agent-core';
import type { ApprovalReason } from './approval-policy';
import type { LaunchValidationGate } from './launch-validation';
import type { ModelHealthTracker } from './model-health';
import { RunTracer, exportSpans, type AttrValue, type Span, type SpanRef } from '../tracing';
import { resolveModel } from './model-registry';
import {
  readySteps,
  parallelWidth,
  type Plan,
  type PlanStep,
  type PlanTracker,
} from './planner';
import { classifyTool } from './tool-policy';
import { RunLedger, type BudgetStopReason, type BudgetUsage, type RunBudgetLimits } from './run-budget';
import type { McpToolDefinition } from './tool-catalog';
import { runWorker, workerTools, type SharedRunState, type WorkerRecord, type WorkerResult } from './worker';
import {
  launchParallelWrites,
  maxReplans as envMaxReplans,
  maxWorkers as envMaxWorkers,
  workerMaxSteps as envWorkerMaxSteps,
  workerModel as envWorkerModel,
  type OrchestrationFlag,
} from './orchestration-config';

// ── Config & gate (Requirements 2.2–2.5) ────────────────────────────────────────

/** Everything the coordinator resolves once for a run, from env + the request. */
export interface OrchestrationConfig {
  /** Concurrent workers: min(MAX_WORKERS, request.maxWorkers) (Requirements 3.1, 3.2). */
  maxWorkers: number;
  /** Replanning calls allowed this run (MAX_REPLANS) (Requirement 6.1). */
  maxReplans: number;
  /** Step cap per worker (WORKER_MAX_STEPS) (Requirement 4.1). */
  workerMaxSteps: number;
  /** Optional model workers run on (WORKER_MODEL); synthesis always uses the run model (Requirement 4.8). */
  workerModelKey?: string;
  /** Launch run with LAUNCH_PARALLEL_WRITES=false: write workers run one at a time (Requirement 3.4). */
  serialWrites: boolean;
}

/**
 * Resolve the orchestration config from the environment and the request
 * (Requirements 3.1, 3.2, 3.4, 4.1, 4.8, 6.1). `maxWorkers` is the smaller of
 * the deployment cap and any per-request one (never larger), floored at 1.
 */
export function orchestrationConfig(req: { maxWorkers?: number }, launchMode: boolean): OrchestrationConfig {
  const cap = envMaxWorkers();
  const requested = req.maxWorkers;
  const maxWorkers =
    requested !== undefined && Number.isFinite(requested) && requested >= 1
      ? Math.min(cap, Math.floor(requested))
      : cap;
  const workerModelKey = envWorkerModel();
  return {
    maxWorkers: Math.max(1, maxWorkers),
    maxReplans: envMaxReplans(),
    workerMaxSteps: envWorkerMaxSteps(),
    ...(workerModelKey ? { workerModelKey } : {}),
    // Launch runs keep write workers serial unless LAUNCH_PARALLEL_WRITES is on
    // (Requirement 3.4; "Reactor writes" decision).
    serialWrites: launchMode && !launchParallelWrites(),
  };
}

/**
 * Whether this run should use the coordinator rather than a single agent loop
 * (Requirements 2.2–2.5).
 *
 *   - ORCHESTRATION=off ignores the request and runs single-agent (2.2).
 *   - ORCHESTRATION=on uses the coordinator only when the request set
 *     `orchestrate: true` (2.3).
 *   - ORCHESTRATION=always uses the coordinator unless the request set
 *     `orchestrate: false` (2.4).
 *   - A plan with fewer than two steps that could ever run at the same time
 *     runs single-agent whatever the flag (2.5); so does a run with no plan.
 */
export function shouldOrchestrate(flag: OrchestrationFlag, requested: boolean | undefined, plan: Plan | undefined): boolean {
  if (flag === 'off') return false;
  if (!plan) return false;
  const enabled = flag === 'always' ? requested !== false : requested === true;
  if (!enabled) return false;
  // Orchestration can only help when two or more steps are independent
  // (Requirement 2.5). parallelWidth is the largest antichain in the plan DAG.
  return parallelWidth(plan) >= 2;
}

// ── runOrchestrated ─────────────────────────────────────────────────────────────

/**
 * Everything the coordinator needs to run a plan. `runAgent` builds this from
 * a `PreparedRun` after `prepareRun`; the coordinator test builds it directly.
 */
export interface OrchestratorInput {
  /** The plan tracker from prepareRun; its plan is mutated as steps complete / are revised. */
  tracker: PlanTracker;
  config: OrchestrationConfig;
  /** The run's policy-filtered tool set; narrowed per step by workerTools. */
  tools: ToolSet;
  /** The full tool catalog, forwarded to workerTools for platform-group expansion. */
  catalog: McpToolDefinition[];
  /** Planning knowledge excerpts shared with each worker (Requirement 4.4). */
  knowledge?: string;
  /** The run's model key (synthesis model; workers' model unless WORKER_MODEL is set). */
  runModelKey: string;
  /** True when the run model was pinned (a request model), which disables worker fallback. */
  isPinned?: boolean;
  /** Run limits, used both for the ledger and (sliced) for each worker's child budget. */
  budgetLimits: RunBudgetLimits;
  modelHealth: ModelHealthTracker;
  launchGate?: LaunchValidationGate;
  abortSignal?: AbortSignal;
  toolApproval?: ToolApprovalFn;
  approvalReasons?: Map<string, ApprovalReason>;
  baseTracerAttrs?: Record<string, AttrValue>;
  /** The run span the coordinator span nests under (Requirement 14.1), when the run is traced. */
  tracerParent?: SpanRef;
  runId?: string;
  toolsConsidered: string[];
  thinkingBudget?: number;
  /** Extended thinking / wall-clock hook: a stable clock for the ledger (tests inject one). */
  now?: () => number;
  // Hooks — forwarded to the run's event stream (Requirement 11).
  /** A worker is starting (Requirement 11.1): workerId, step, model and its narrowed tool names. */
  onWorkerStart?: (info: { workerId: string; stepId: number; modelKey: string; tools: string[] }) => void;
  /** A worker finished (Requirement 11.2): its full record. */
  onWorker?: (worker: WorkerRecord) => void;
  /** A worker step finished; `workerId` tags it so the stream files it under that worker (Requirement 11.3). */
  onStep?: (step: AgentStepTrace, workerId?: string) => void;
  onTextDelta?: (delta: string) => void;
  /** A tool call finished; `workerId` tags it so its audit entry carries the worker (Requirement 9.6). */
  onToolOutcome?: (outcome: ToolOutcome, workerId?: string) => void;
  onRestart?: (info: { fromModelKey: string; toModelKey: string; workerId: string }) => void;
  onPlan?: (plan: Plan) => void;
}

/** One finished worker, tagged with its step so the scheduler can apply it. */
interface WorkerOutcome {
  stepId: number;
  record: WorkerRecord;
}

/**
 * Run a plan with the coordinator and return the same AgentRunResult shape a
 * single-agent run produces (Requirement 7.3's consumers downstream don't need
 * to know which path ran). `orchestrated` is true; `replans` reports how many
 * replanning calls happened.
 */
export async function runOrchestrated(input: OrchestratorInput): Promise<AgentRunResult> {
  const { tracker, config } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const ledger = new RunLedger(input.budgetLimits, startedAt, now);

  // Requirement 14.1: the coordinator opens one span for the whole
  // orchestration; every worker's trace nests under it (shared.tracerParent),
  // and the coordinator also records a summary child span per finished worker
  // (recordWorkerSpan). The coordinator span joins the run's trace when the
  // caller passed one, so the full tree is run → coordinator → worker → step.
  const coordinatorTracer = new RunTracer(
    { ...(input.baseTracerAttrs ?? {}), 'harness.orchestration': true },
    now,
    input.tracerParent
  );
  const coordinatorRef: SpanRef = coordinatorTracer.ref();
  const workerSpans: Span[] = [];

  const shared: SharedRunState = {
    ledger,
    modelHealth: input.modelHealth,
    tracerParent: coordinatorRef,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.launchGate ? { launchGate: input.launchGate } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.toolApproval ? { toolApproval: input.toolApproval } : {}),
    ...(input.approvalReasons ? { approvalReasons: input.approvalReasons } : {}),
    ...(input.baseTracerAttrs ? { baseTracerAttrs: input.baseTracerAttrs } : {}),
  };

  /**
   * Record a summary child span for a finished worker under the coordinator
   * span (Requirement 14.1): one span per worker carrying the worker id, step,
   * attempt, model, status and token spend, so a backend shows the worker
   * fan-out at the coordinator level even though the worker's own step spans
   * live in its nested trace.
   */
  const recordWorkerSpan = (record: WorkerRecord): void => {
    const startMs = Date.parse(record.startedAt);
    const start = Number.isFinite(startMs) ? startMs : now();
    workerSpans.push({
      traceId: coordinatorRef.traceId,
      spanId: `${coordinatorRef.spanId.slice(0, 8)}${String(record.stepId).padStart(4, '0').slice(-4)}${String(record.attempt).padStart(4, '0').slice(-4)}`,
      parentSpanId: coordinatorRef.spanId,
      name: `worker step ${record.stepId}`,
      startMs: start,
      endMs: start + (record.durationMs ?? 0),
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'harness.worker.id': record.workerId,
        'harness.worker.step_id': record.stepId,
        'harness.worker.attempt': record.attempt,
        'harness.worker.status': record.status,
        'gen_ai.request.model': record.modelKey,
        'gen_ai.usage.total_tokens': record.budgetUsage.tokens,
      },
      ...(record.error ? { error: record.error } : {}),
    });
  };

  // WorkerResult per done/failed step, so a dependant's brief carries its
  // dependencies' results (Requirement 4.4) and synthesis sees every outcome.
  const results = new Map<number, WorkerResult>();
  const workers: WorkerRecord[] = [];
  // The next attempt number for a step (a restart would bump it; a fresh
  // worker for a revised step starts at 1).
  const attempts = new Map<number, number>();
  let replans = 0;
  let stopReason: BudgetStopReason | undefined;
  const steps: AgentStepTrace[] = [];

  const workerModelKey = config.workerModelKey ?? input.runModelKey;

  const isWriteStep = (step: PlanStep): boolean => Boolean(step.tool) && classifyTool(step.tool as string) !== 'read';
  const aborted = (): boolean => Boolean(input.abortSignal?.aborted);

  /** Mark a step and notify the plan listener (Requirement 3.5). */
  const setStatus = (step: PlanStep, status: PlanStep['status']): void => {
    tracker.update(step.id, status);
    input.onPlan?.(tracker.plan);
  };

  const stepById = (id: number): PlanStep | undefined => tracker.plan.steps.find((s) => s.id === id);
  const hasDependants = (step: PlanStep): boolean => tracker.plan.steps.some((s) => s.dependsOn.includes(step.id));

  /**
   * What a worker's brief carries from its dependencies (Requirement 4.4).
   * A reasoning step (`tool: null`) has no worker and no result, so it is
   * walked through: its description is folded into this step's brief and its
   * own dependencies' results are handed on. Folded steps come out in
   * dependency order (deepest first).
   */
  const gatherInputs = (step: PlanStep): { deps: WorkerResult[]; folded: PlanStep[] } => {
    const deps: WorkerResult[] = [];
    const folded: PlanStep[] = [];
    const seen = new Set<number>();
    const visit = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const dep = stepById(id);
      if (dep && dep.tool === null) {
        for (const d of dep.dependsOn) visit(d);
        folded.push(dep);
        return;
      }
      const r = results.get(id);
      if (r) deps.push(r);
    };
    for (const id of step.dependsOn) visit(id);
    return { deps, folded };
  };

  /**
   * Reasoning steps (`tool: null`) never get a worker (Requirement 3.7). One
   * that other steps depend on is marked done as soon as its own dependencies
   * are, so its dependants become ready; its work is folded into their briefs
   * (gatherInputs). One with no dependants stays pending for synthesis.
   */
  const completeFoldedSteps = (): void => {
    for (;;) {
      const next = readySteps(tracker.plan).find((s) => s.tool === null && hasDependants(s));
      if (!next) return;
      tracker.update(next.id, 'done', 'folded into the steps that depend on it');
      input.onPlan?.(tracker.plan);
    }
  };

  /** Start one worker for a ready step; records its workerId on the step (Requirement 3.5). */
  const startWorker = (step: PlanStep): Promise<WorkerOutcome> => {
    const attempt = attempts.get(step.id) ?? 1;
    attempts.set(step.id, attempt);
    // Step ids are renumbered when the plan is revised, so after a replan the
    // plan version goes into the id to keep it unique within the run.
    const version = tracker.plan.version > 1 ? `v${tracker.plan.version}:` : '';
    const workerId = `${input.runId ?? 'run'}:${version}w${step.id}:${attempt}`;
    step.workerId = workerId;
    setStatus(step, 'running');
    const { deps, folded } = gatherInputs(step);

    // Requirement 11.1: announce the worker before it runs, with the model and
    // the names of its narrowed tool set so the client can label the lane.
    const narrowed = Object.keys(workerTools(input.tools, step, input.catalog));
    input.onWorkerStart?.({ workerId, stepId: step.id, modelKey: workerModelKey, tools: narrowed });

    return runWorker({
      workerId,
      runGoal: tracker.plan.goal,
      step,
      deps,
      ...(folded.length ? { folded } : {}),
      ...(input.knowledge ? { knowledge: input.knowledge } : {}),
      tools: input.tools,
      catalog: input.catalog,
      modelKey: workerModelKey,
      ...(input.isPinned ? { isPinned: input.isPinned } : {}),
      maxSteps: config.workerMaxSteps,
      shared,
      attempt,
      ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
      // Requirement 11.3: tag every worker step with its workerId as it is
      // forwarded, so the stream and checkpoint file it under the right lane.
      ...(input.onStep ? { onStep: (s: AgentStepTrace) => input.onStep?.(s, workerId) } : {}),
      ...(input.onToolOutcome ? { onToolOutcome: (o: ToolOutcome) => input.onToolOutcome?.(o, workerId) } : {}),
      onRestart: (info) => input.onRestart?.({ ...info, workerId }),
    }).then((record) => ({ stepId: step.id, record }));
  };

  /** Apply a finished worker: record it, update the step, fan the result out (Requirements 5.3, 5.4). */
  const applyOutcome = (outcome: WorkerOutcome): void => {
    const { record } = outcome;
    const step = tracker.plan.steps.find((s) => s.id === outcome.stepId);
    workers.push(record);
    recordWorkerSpan(record);
    input.onWorker?.(record);
    for (const s of record.steps) steps.push(s);
    if (!step) return;
    if (record.result) results.set(step.id, record.result);
    if (record.status === 'done') {
      setStatus(step, 'done');
    } else {
      // failed or cancelled — the step did not complete (Requirement 5.4).
      setStatus(step, 'failed');
    }
  };

  // ── Scheduler loop ────────────────────────────────────────────────────────────
  // Single-threaded and event-driven: fill ready slots, await the first worker
  // to finish, apply it, repeat. A failed step triggers replanning only after
  // the running set drains, so the replan sees every finished result
  // (Requirement 6.1).
  const running = new Map<number, Promise<WorkerOutcome>>();
  let needReplan = false;

  const hasPendingWork = (): boolean => tracker.plan.steps.some((s) => s.status === 'pending' && s.tool !== null);

  for (;;) {
    // Requirements 8.4 / 9.4: stop scheduling on abort or a spent ledger. Keep
    // draining the workers already running so their spend is recorded.
    const haltNew = aborted() || Boolean(ledger.exhausted());
    if (!haltNew) {
      completeFoldedSteps();
      for (const step of readySteps(tracker.plan)) {
        if (running.size >= config.maxWorkers) break;
        if (running.has(step.id)) continue;
        // tool === null steps are kept for synthesis, never run as workers
        // (Requirement 3.7).
        if (step.tool === null) continue;
        // Serial writes in Launch runs: at most one write/destructive worker at
        // a time (Requirement 3.4).
        if (config.serialWrites && isWriteStep(step)) {
          const anyRunningWrite = [...running.keys()].some((id) => {
            const s = tracker.plan.steps.find((x) => x.id === id);
            return s ? isWriteStep(s) : false;
          });
          if (anyRunningWrite) continue;
        }
        running.set(step.id, startWorker(step));
      }
    }

    if (running.size === 0) {
      // Nothing running. Either a failed step needs a replan, or there's no
      // more work we can schedule.
      if (needReplan && !haltNew) {
        needReplan = false;
        const replanned = await tryReplan();
        if (replanned) continue;
        // Replan failed or hit the cap: skip the rest and synthesise
        // (Requirement 6.3). skipRemaining marks them so synthesis reports them.
        skipRemaining();
        break;
      }
      break;
    }

    const outcome = await Promise.race(running.values());
    running.delete(outcome.stepId);
    applyOutcome(outcome);

    if (outcome.record.status !== 'done') {
      // A step failed. Replanning happens once the running set has drained so
      // the replan call sees every finished result (Requirement 6.1).
      needReplan = true;
    }

    // The run ledger ran out while workers were in flight: let the running set
    // drain, then stop (Requirement 8.4). Record the reason for the result.
    const exhausted = ledger.exhausted();
    if (exhausted) stopReason = exhausted;
  }

  if (aborted()) stopReason ??= 'time-budget';

  /** One replanning call, applied through PlanTracker.revise (Requirements 6.1–6.3). */
  async function tryReplan(): Promise<boolean> {
    if (replans >= config.maxReplans) return false;
    replans += 1;
    const failed = tracker.plan.steps.filter((s) => s.status === 'failed');
    let revised: ReplanResult;
    try {
      revised = await requestReplan({
        goal: tracker.plan.goal,
        plan: tracker.plan,
        results,
        failed,
        modelKey: input.runModelKey,
        toolNames: input.toolsConsidered,
        abortSignal: input.abortSignal,
      });
    } catch (err) {
      console.warn('[coordinator] replanning call failed; skipping remaining steps:', err instanceof Error ? err.message : err);
      return false;
    }
    if (!revised.steps.length) return false;
    const outcome = tracker.revise(revised.reason, revised.steps);
    if (!outcome.ok) {
      console.warn('[coordinator] revised plan rejected; skipping remaining steps:', outcome.message);
      return false;
    }
    // Kept steps were renumbered from 1: carry their results over to the new
    // ids and drop the rest, so no new step inherits an old step's result.
    const remapped = new Map<number, WorkerResult>();
    for (const [oldId, newId] of outcome.renumbered ?? []) {
      const r = results.get(oldId);
      if (r) remapped.set(newId, { ...r, stepId: newId });
    }
    results.clear();
    for (const [id, r] of remapped) results.set(id, r);
    attempts.clear();
    input.onPlan?.(tracker.plan);
    return true;
  }

  /** Mark every not-done step skipped so synthesis reports it (Requirement 6.3). */
  function skipRemaining(): void {
    let changed = false;
    for (const step of tracker.plan.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        tracker.update(step.id, 'skipped');
        changed = true;
      }
    }
    if (changed) input.onPlan?.(tracker.plan);
  }

  // Nothing pending that a worker could pick up, but a replan is still owed
  // (e.g. the ledger halted new work mid-failure): never leave a step dangling.
  if (hasPendingWork() && (aborted() || ledger.exhausted())) skipRemaining();

  // ── Synthesis (Requirements 7.1, 7.2) ──────────────────────────────────────────
  const synthesis = await synthesize({
    goal: tracker.plan.goal,
    plan: tracker.plan,
    results,
    modelKey: input.runModelKey,
    abortSignal: input.abortSignal,
    stopReason,
    onTextDelta: input.onTextDelta,
  });
  if (synthesis.usageTokens) ledger.charge(synthesis.usageTokens, synthesis.costUsd);

  const budgetUsage: BudgetUsage = ledger.usage();

  // Requirement 14.1: close the coordinator span and export it with the
  // per-worker summary spans. Best-effort, exactly like executeLoop's export
  // (exportSpans never throws), so tracing can't disturb the run.
  try {
    const coordinatorSpans = coordinatorTracer.finish({
      attributes: {
        'harness.orchestration.workers': workers.length,
        'harness.orchestration.replans': replans,
        ...(stopReason ? { 'harness.stop_reason': stopReason } : {}),
      },
    });
    void exportSpans([...coordinatorSpans, ...workerSpans]);
  } catch (err) {
    console.error('[coordinator] failed to finish/export coordinator trace:', err instanceof Error ? err.message : err);
  }

  return {
    finalText: synthesis.text,
    steps,
    toolsConsidered: input.toolsConsidered,
    finishReason: synthesis.finishReason,
    modelKey: input.runModelKey,
    ...(stopReason ? { stopReason } : {}),
    budgetUsage,
    usage: { totalTokens: budgetUsage.tokens },
    ragJudgments: [],
    plan: tracker.plan,
    orchestrated: true,
    replans,
    workers,
  };
}

// ── Replanning ──────────────────────────────────────────────────────────────────

interface ReplanResult {
  reason: string;
  steps: Array<{ description: string; tool: string | null; expectedOutput: string; dependsOn?: number[] }>;
}

const replanSchema = z.object({
  reason: z.string().max(300).describe('Why the plan is changing, in one sentence.'),
  steps: z
    .array(
      z.object({
        description: z.string().max(200).describe('One concrete action.'),
        tool: z.string().nullable().describe('The exact tool name this step will call, or null for a reasoning/answer step.'),
        expectedOutput: z.string().max(200).describe('What shows the step succeeded.'),
        dependsOn: z
          .array(z.number().int())
          .optional()
          .describe('Ids of earlier steps this step needs, numbered as in the revised plan: kept done steps first, then these new steps in order.'),
      })
    )
    .max(8),
});

/**
 * One replanning call (Requirement 6.1): the model is given the goal, every
 * completed result and the failure, and returns the steps that should replace
 * the not-done ones. The caller remaps `dependsOn` to the revised ids via
 * `PlanTracker.revise` (Requirement 6.2).
 */
async function requestReplan(args: {
  goal: string;
  plan: Plan;
  results: Map<number, WorkerResult>;
  failed: PlanStep[];
  modelKey: string;
  toolNames: string[];
  abortSignal?: AbortSignal;
}): Promise<ReplanResult> {
  // The revised plan renumbers the completed steps 1..n in this order and
  // numbers the new steps after them, so list them under those ids.
  const done = args.plan.steps.filter((s) => s.status === 'done');
  const completedLines = done.map((s, i) => {
    const r = args.results.get(s.id);
    const ids = r && Object.keys(r.ids).length ? ` ids=${JSON.stringify(r.ids)}` : '';
    return `- Step ${i + 1} (${s.description}): ${r?.summary ?? 'done'}${ids}`;
  });
  const failureLines = args.failed.map((s) => {
    const r = args.results.get(s.id);
    return `- ${s.description} FAILED: ${r?.summary ?? s.note ?? 'no result'}`;
  });

  const { object } = await generateObject({
    model: resolveModel(args.modelKey),
    schema: replanSchema,
    system: [
      'You are revising a plan for a MarTech engineering agent after a step failed.',
      'Produce the MINIMUM set of steps that still achieves the goal given what already succeeded.',
      'Do not repeat completed steps. Each new step names the exact tool it will call (from the list) or null, and a checkable expected output.',
      `Number dependencies as in the revised plan: the completed steps are 1-${done.length} as listed, and your new steps are ${done.length + 1}, ${done.length + 2}, … in order.`,
    ].join('\n'),
    prompt: [
      `Goal: ${args.goal}`,
      '',
      completedLines.length ? `Completed so far:\n${completedLines.join('\n')}` : 'Nothing completed yet.',
      '',
      failureLines.length ? `Failed:\n${failureLines.join('\n')}` : '',
      '',
      `Tools available: ${args.toolNames.join(', ')}`,
    ].join('\n'),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });
  return object;
}

// ── Synthesis ────────────────────────────────────────────────────────────────────

interface SynthesisResult {
  text: string;
  finishReason: string;
  usageTokens?: number;
  costUsd?: number;
}

/**
 * One synthesis call writes the final answer from the goal and every
 * WorkerResult, including failed and skipped steps (Requirement 7.1). The text
 * is streamed as `text_delta` (Requirement 7.2). If the call fails, the answer
 * falls back to a plain list of the step summaries so the run still returns an
 * answer (Error-handling table: "Synthesis call fails").
 */
async function synthesize(args: {
  goal: string;
  plan: Plan;
  results: Map<number, WorkerResult>;
  modelKey: string;
  abortSignal?: AbortSignal;
  stopReason?: BudgetStopReason;
  onTextDelta?: (delta: string) => void;
}): Promise<SynthesisResult> {
  const stepLines = args.plan.steps.map((s) => {
    const r = args.results.get(s.id);
    const ids = r && Object.keys(r.ids).length ? ` ids=${JSON.stringify(r.ids)}` : '';
    const detail = r ? `${r.summary}${ids}${r.notes ? ` — ${r.notes}` : ''}` : s.note ?? '';
    return `- Step ${s.id} [${s.status}] ${s.description}${detail ? `: ${detail}` : ''}`;
  });

  const prompt = [
    `Goal: ${args.goal}`,
    '',
    'Results of each step:',
    ...stepLines,
    '',
    args.stopReason ? `Note: the run stopped early (${args.stopReason}).` : '',
    'Write the final answer for the user: what was accomplished, the ids they need, and plainly state any step that failed or was not done.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const stream = streamText({
      model: resolveModel(args.modelKey),
      system:
        'You are writing the final answer for a MarTech engineering run from the outcomes of its steps. ' +
        'Be concise and factual. State what was done, include the ids the user needs, and clearly call out anything that failed or was skipped. Do not invent results.',
      messages: [{ role: 'user', content: prompt }],
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });

    if (args.onTextDelta) {
      for await (const part of stream.fullStream) {
        if (part.type === 'text-delta') args.onTextDelta(part.text);
      }
    }

    const [text, finishReason, usage] = await Promise.all([stream.text, stream.finishReason, stream.usage]);
    return {
      text,
      finishReason,
      ...(usage.totalTokens !== undefined ? { usageTokens: usage.totalTokens } : {}),
    };
  } catch (err) {
    console.warn('[coordinator] synthesis call failed; returning a plain list of step summaries:', err instanceof Error ? err.message : err);
    const fallback = [`Here is what each step of "${args.goal}" produced:`, ...stepLines].join('\n');
    // Stream the fallback too, so a client that only renders text_delta still
    // sees the answer.
    args.onTextDelta?.(fallback);
    return { text: fallback, finishReason: 'error' };
  }
}
