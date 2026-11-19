/**
 * The agent entry point: runAgent = prepareRun (prepare-run.ts) followed by
 * executeLoop (agent-loop.ts). Options/result types live in agent-options.ts,
 * provider options in provider-options.ts, context compression in
 * context-compression.ts, tool selection in tool-selection.ts and step traces
 * in step-trace.ts.
 *
 * Runtime optimisations layered on top of the basic generateText loop:
 *
 *   1. Prompt caching (TASK 1): the system prompt is sent as a SystemModelMessage
 *      via `instructions` (AI SDK v7 rejects system messages inside `messages`)
 *      with providerOptions.anthropic.cacheControl so Anthropic
 *      and Bedrock cache it after the first step. Tool definitions are similarly
 *      cached via toolOrder stability (shortlist never shuffles). Cache-write on
 *      the first step, much-cheaper cache-read on every subsequent step.
 *
 *   2. Context management (TASK 2): tool results from older steps stop being
 *      resent at full size. Normally prepareStep swaps them for a one-line
 *      summary. Models that bind thinking to the exact prior conversation
 *      (see HISTORY_BOUND_MODEL_RE) reject any rewrite of earlier messages, so
 *      for those the API's server-side context editing clears them instead.
 *      The trace keeps the uncompressed results (each already capped at 8K
 *      chars by capToolResult) — only the in-flight model context shrinks.
 *
 *   3. Last-step summary (TASK 3): the final allowed step is steered to a
 *      written answer so the run doesn't end cut off mid-tool-call when
 *      stepCountIs fires. (So with maxSteps=1 the run is text-only.)
 *
 *   6. Tool discovery (TASK 6): the tool list the model sees is fixed for the
 *      whole run — the shortlist plus `find_tools` and `call_tool`. find_tools
 *      searches the rest of the (policy-filtered) catalog and returns schemas;
 *      call_tool runs any of those by name. Keeping the list fixed preserves
 *      the prompt cache and never trips the history-binding check above,
 *      which swapping tools in and out mid-run would.
 *
 *   9. Approval (TASK 9): destructive calls wait for a human decision via
 *      RunAgentOptions.approveTool; without an approver they're denied.
 */

import { getDefaultModelKey } from '../models/model-registry';
import { getMcpToolCatalog } from '../tools/tool-catalog';
import {
  ALWAYS_ON_TOOLS,
  type AgentStepTrace,
  type TokenUsage,
  type ToolOutcome,
  type LoopContext,
  type LoopResult,
  type PreparedRun,
  type EarlyResult,
} from './agent-core';
import { orchestrationConfig, orchestrationRequested, runOrchestrated, shouldOrchestrate } from './coordinator';
import { orchestrationFlag } from './orchestration-config';
import { RunTracer, exportSpans, type AttrValue } from '../../tracing';
import { type AgentRunResult, type RunAgentOptions } from './agent-options';
import { prepareRun } from './prepare-run';
import { executeLoop } from './agent-loop';

export { ALWAYS_ON_TOOLS };
export type { AgentStepTrace, TokenUsage, ToolOutcome, LoopContext, LoopResult, PreparedRun, EarlyResult };
export type { AgentRunResult, RunAgentOptions } from './agent-options';
export { prepareRun } from './prepare-run';
export { resolveLaunchMode } from '../domains/launch/pack';
export { executeLoop } from './agent-loop';

/**
 * The public agent entry point (Requirements 1.3, 1.4): unchanged signature
 * and unchanged AgentRunResult shape, now implemented as prepareRun() followed
 * by executeLoop(). When setup produced an early answer (unclear request or a
 * denied plan), the EarlyResult is returned as-is; otherwise the LoopResult is
 * folded back together with the setup outputs into the same AgentRunResult the
 * single function returned before.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const prepared = await prepareRun(opts);
  if (prepared.kind === 'early') {
    return prepared.result;
  }

  const { ctx, toolsConsidered, planTracker, route, versions, ragJudgmentSink, planningRetrieval } = prepared;

  // Requirements 2.3–2.5: use the coordinator when orchestration is enabled
  // for this run and the plan has two or more steps that could run at the same
  // time. A plan with a cycle / unknown dependency never reaches here (the
  // planner rejects it), and a plan too serial to parallelise falls through to
  // the single-agent loop with `orchestrated: false` (Requirement 2.5).
  if (planTracker && shouldOrchestrate(orchestrationFlag(), opts.orchestrate, planTracker.plan)) {
    const config = orchestrationConfig({ ...(opts.maxWorkers !== undefined ? { maxWorkers: opts.maxWorkers } : {}) }, ctx.launchMode);
    // workerTools reads the catalog only for tool names (to find platform-group
    // siblings). The eval path's injected tools stand in for the MCP catalog,
    // so eval workers get the same sibling expansion as live ones.
    const catalog = opts.tools
      ? Object.entries(opts.tools).map(([name, t]) => ({
          name,
          description: (t as { description?: string }).description ?? '',
          inputSchema: { type: 'object' },
        }))
      : await getMcpToolCatalog();
    const runModelKey = ctx.startModelKey ?? getDefaultModelKey();
    // Requirement 14.1: one run span, with the coordinator span under it and
    // each worker under that — run → coordinator → worker → step. A
    // single-agent run's loop span is its run span; here the coordinator and
    // workers each open their own, so the run needs one of its own.
    const runTracer = new RunTracer({ ...ctx.baseTracerAttrs, 'gen_ai.request.model': runModelKey, 'harness.orchestrated': true });
    const finishRunTrace = (extra: { attributes?: Record<string, AttrValue>; error?: string }): void => {
      try {
        void exportSpans(runTracer.finish(extra));
      } catch (err) {
        console.error('[tracing] failed to finish/export run trace:', err instanceof Error ? err.message : err);
      }
    };
    let orchestrated: AgentRunResult;
    try {
      orchestrated = await runOrchestrated({
        tracker: planTracker,
        request: opts.userInput,
        config,
        ...(opts.resumePlan ? { seedResults: opts.resumePlan.results } : {}),
        tools: ctx.tools,
        catalog,
        ...(planningRetrieval?.context ? { knowledge: planningRetrieval.context } : {}),
        runModelKey,
        isPinned: ctx.isPinned,
        budgetLimits: ctx.budgetLimits,
        modelHealth: ctx.modelHealth,
        // Requirement 9.1: the run's single LaunchValidationGate, shared by every
        // worker. It is already embedded in `ctx.tools` (so a worker's narrowed
        // tool set calls through the same instance); passing it here also tells
        // each worker it is in a gated Launch run (worker launchMode grounding).
        ...(ctx.launchGate ? { launchGate: ctx.launchGate } : {}),
        ...(ctx.segmentMode ? { segmentMode: true } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        ...(ctx.toolApproval ? { toolApproval: ctx.toolApproval } : {}),
        approvalReasons: ctx.approvalReasons,
        baseTracerAttrs: ctx.baseTracerAttrs,
        tracerParent: runTracer.ref(),
        ...(opts.runId ? { runId: opts.runId } : {}),
        toolsConsidered,
        ...(ctx.thinkingBudget !== undefined ? { thinkingBudget: ctx.thinkingBudget } : {}),
        ...(opts.onWorkerStart ? { onWorkerStart: opts.onWorkerStart } : {}),
        ...(opts.onWorker ? { onWorker: opts.onWorker } : {}),
        // Requirement 11.3: forward the worker-tagged step straight through so the
        // route can attach the workerId to the step event and checkpoint. The
        // coordinator supplies the workerId (executeLoop's own ctx.onStep never
        // has one), so forward opts.onStep, which carries the optional arg.
        ...(opts.onStep ? { onStep: (step, workerId) => opts.onStep?.(step, workerId) } : {}),
        ...(ctx.onTextDelta ? { onTextDelta: ctx.onTextDelta } : {}),
        // Requirement 9.6: forward the worker-tagged outcome so its audit entry
        // carries the workerId. opts.onToolOutcome accepts the optional arg.
        ...(opts.onToolOutcome ? { onToolOutcome: (outcome, workerId) => opts.onToolOutcome?.(outcome, workerId) } : {}),
        ...(opts.onRestart ? { onRestart: ({ fromModelKey, toModelKey, workerId }) => opts.onRestart?.({ fromModelKey, toModelKey, workerId }) } : {}),
        ...(opts.onPlan ? { onPlan: opts.onPlan } : {}),
      });
    } catch (err) {
      finishRunTrace(
        ctx.abortSignal?.aborted
          ? { error: 'aborted', attributes: { 'harness.aborted': true } }
          : { error: err instanceof Error ? err.message : String(err) }
      );
      throw err;
    }
    finishRunTrace({
      attributes: {
        'harness.usage.total_tokens': orchestrated.budgetUsage.tokens,
        'harness.duration_ms': orchestrated.budgetUsage.durationMs,
        ...(orchestrated.budgetUsage.costUsd !== undefined ? { 'harness.cost_usd': orchestrated.budgetUsage.costUsd } : {}),
        ...(orchestrated.stopReason ? { 'harness.stop_reason': orchestrated.stopReason } : {}),
      },
    });
    const ragJudgments = ragJudgmentSink ? await ragJudgmentSink.drain() : [];
    return { ...orchestrated, ragJudgments, versions, ...(route ? { route } : {}) };
  }

  const loop = await executeLoop(ctx);

  // The judge ran concurrently with the loop; await any still in flight now
  // (off the tool-call critical path) so the verdicts are captured with the
  // run record. drain() never rejects.
  const ragJudgments = ragJudgmentSink ? await ragJudgmentSink.drain() : [];

  return {
    finalText: loop.text,
    steps: loop.steps,
    toolsConsidered,
    finishReason: loop.finishReason,
    modelKey: loop.modelKey,
    ...(loop.stopReason ? { stopReason: loop.stopReason } : {}),
    budgetUsage: loop.budgetUsage,
    usage: loop.usage,
    ragJudgments,
    versions,
    ...(planTracker ? { plan: planTracker.plan } : {}),
    ...(route ? { route } : {}),
    // Requirement 2.5: orchestration was asked for but the plan (or the lack
    // of one) left nothing to run in parallel, so this ran single-agent.
    ...(orchestrationRequested(orchestrationFlag(), opts.orchestrate) ? { orchestrated: false } : {}),
  };
}
