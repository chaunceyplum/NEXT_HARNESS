/** The model/tool loop half of a run. See executeLoop. */

import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { getDefaultModelKey, getModelRegistry, resolveModel } from '../models/model-registry';
import { effectiveToolCall } from '../tools/tool-discovery';
import { promptOptionsFor, stage, type LoopContext, type LoopResult } from './agent-core';
import { classifyProviderFailure } from '../models/model-health';
import { classifyTool } from '../tools/tool-policy';
import { budgetFinalNote, RunBudgetTracker, type BudgetStopReason } from './run-budget';
import { acquireLoopSlot } from './agent-slots';
import { toTokenUsage } from '../models/pricing';
import { RunTracer, exportSpans, type AttrValue } from '../../tracing';
import {
  buildSystemMessage,
  cacheMarker,
  withCacheBreakpoint,
  isHistoryBound,
  contextEditingProviderOptions,
  mergeProviderOptions,
  resolveThinkingProviderOptions,
} from './provider-options';
import { compressOldToolMessages } from './context-compression';
import { recordStepSpan, toStepTrace, toolOutcomes } from './step-trace';

/** How far past the time budget a run may go (to finish the step in flight and wrap up) before it's aborted. */
const HARD_TIMEOUT_GRACE_MS = 5 * 60_000;

/** Appended on the final step for history-bound models, which can't drop the tools array. */
const FINAL_STEP_NOTE =
  'This is your last step: do not call any more tools. Write your final answer now, based on what you have done so far.';


/**
 * Execution half of a run (Requirement 1.2): the streaming tool loop, budget
 * enforcement, context compression, same-tier fallback, tracing and result
 * assembly. Every input is read from {@link LoopContext} — no enclosing
 * closure — so a worker (Phase 2) can drive the same loop with its own ctx.
 *
 * This is a behaviour-preserving extraction of the second half of the old
 * single runAgent(): the only new output is {@link LoopResult.hadSideEffects},
 * which exposes what was the internal `attemptHadSideEffects` flag so the
 * caller (and later a per-worker fallback) can see whether the attempt wrote.
 */
export async function executeLoop(ctx: LoopContext): Promise<LoopResult> {
  const {
    tools,
    launchMode,
    publishEnabled,
    segmentMode,
    userMessage,
    startModelKey,
    isPinned,
    maxSteps,
    budgetLimits,
    modelHealth,
    toolApproval,
    approvalReasons,
    baseTracerAttrs,
    abortSignal,
  } = ctx;

  // A fresh tracer per model attempt so a same-tier fallback's abandoned steps
  // don't leak into the exported trace (they get their own tracer, never
  // finished). `tracer` always points at the current attempt; finish() +
  // exportSpans() run once the loop settles, on both success and error.
  // Tracing reads only what the SDK already reports per step, so it never
  // changes the agent's behaviour, and export is best-effort (never throws).
  // Phase 3 (workers): when the coordinator passes a parent span, each
  // attempt's tracer nests under it so the run's spans form one tree
  // (Requirement 14.1). Single-agent runs leave it undefined, so the trace
  // opens fresh exactly as before.
  let tracer = new RunTracer(baseTracerAttrs, Date.now, ctx.tracerParent);

  const registry = getModelRegistry();

  // TASK 8: step counter for onStepEnd → onStep mapping. Reset per model
  // attempt, since a fallback restarts the run from scratch.
  let stepIndex = 0;
  const runStartedAt = Date.now();
  // Per model attempt, like stepIndex (a fallback restarts the run). A worker
  // passes ctx.budgetParent so each step charges the run ledger too
  // (Requirements 8.1, 8.3); single-agent runs leave it undefined, so the
  // tracker has no parent and behaves exactly as before.
  let budget = new RunBudgetTracker(budgetLimits, startModelKey || getDefaultModelKey(), runStartedAt, Date.now, ctx.budgetParent);
  let stopReason: BudgetStopReason | undefined;
  // Whether the current attempt has executed a write/destructive tool call —
  // if so, falling back would re-run those side effects on the next model.
  let attemptHadSideEffects = false;

  const callModel = (resolvedModelKey: string) => {
    stepIndex = 0;
    attemptHadSideEffects = false;
    budget = new RunBudgetTracker(budgetLimits, resolvedModelKey, runStartedAt, Date.now, ctx.budgetParent);
    stopReason = undefined;
    // Fresh tracer for this attempt (a fallback restarts the run from scratch),
    // still nested under the coordinator span when one was passed.
    tracer = new RunTracer({ ...baseTracerAttrs, 'gen_ai.request.model': resolvedModelKey }, Date.now, ctx.tracerParent);
    // Step index at which a budget forced the wrap-up step; the loop stops after it.
    let forcedAt: number | undefined;

    // TASK 10: resolve thinking config for this model + request combination
    const thinkingProviderOptions = resolveThinkingProviderOptions(resolvedModelKey, ctx.thinkingBudget);
    if (thinkingProviderOptions) {
      console.log(`[agent] extended thinking enabled (${resolvedModelKey}): ${JSON.stringify(thinkingProviderOptions)}`);
    }
    const historyBound = isHistoryBound(resolvedModelKey);
    const conversationCacheMarker = cacheMarker(resolvedModelKey);
    const providerOptions = mergeProviderOptions(
      thinkingProviderOptions,
      historyBound ? contextEditingProviderOptions(resolvedModelKey) : undefined
    ) as Record<string, Record<string, never>> | undefined;

    return stage(`chat model call (${resolvedModelKey})`, async () => {
      // TASK 1 (token streaming): streamText instead of generateText so the
      // assistant's text is emitted as it's produced. Everything else — the
      // multi-step loop (stopWhen), prepareStep context management, the
      // approval gate, abort, thinking/context-editing providerOptions, and
      // the onStepEnd trace/side-effect tracking — is unchanged; streamText
      // takes the same options. We consume fullStream to forward text deltas,
      // then await the terminal promises for the same result shape the
      // fallback loop and result construction below already expect.
      const stream = streamText({
        model: resolveModel(resolvedModelKey),
        // TASK 1: system prompt with provider-specific cache markers
        instructions: buildSystemMessage(resolvedModelKey, promptOptionsFor(tools, { launchMode, publishEnabled, segmentMode })),
        messages: [{ role: 'user', content: userMessage }],
        tools,
        stopWhen: [stepCountIs(maxSteps), ({ steps }) => forcedAt !== undefined && steps.length > forcedAt],
        abortSignal,
        // Hard backstop for the time budget, which is otherwise checked
        // between steps: one step that hangs (or waits on an approval) past
        // it still gets cut off, with room left for the wrap-up step.
        ...(budgetLimits.maxDurationMs !== undefined
          ? { timeout: { totalMs: budgetLimits.maxDurationMs + HARD_TIMEOUT_GRACE_MS - (Date.now() - runStartedAt) } }
          : {}),
        // TASK 10 (thinking) + TASK 2 (server-side context editing)
        ...(providerOptions ? { providerOptions } : {}),
        ...(toolApproval ? { toolApproval } : {}),
        prepareStep: ({ steps, messages }) => {
          // Run budgets / loop detection (run-budget.ts): a hit limit turns
          // this step into the wrap-up step, and repeated calls get a warning.
          const exceeded = budget.exceeded();
          if (exceeded && forcedAt === undefined) {
            forcedAt = steps.length;
            stopReason = exceeded;
          }
          const isLastStep = steps.length >= maxSteps - 1 || forcedAt !== undefined;
          const notes = budget.takeWarnings();
          if (exceeded) notes.push(budgetFinalNote(exceeded));
          // Phase 2: a worker loop ends on its forced tool (report_result)
          // rather than on free text, so on the last step a history-bound
          // model is told to call that tool instead of the generic
          // "write your final answer" note (Requirement 4.6). A budget
          // wrap-up (`exceeded`) still gets budgetFinalNote above so the run
          // stops cleanly rather than making one more tool call it can't pay
          // for.
          else if (historyBound && isLastStep) {
            notes.push(ctx.forceFinalTool ? `Call ${ctx.forceFinalTool} now.` : FINAL_STEP_NOTE);
          }
          const withNotes = (base: ModelMessage[]): ModelMessage[] =>
            notes.length ? [...base, { role: 'user' as const, content: notes.join('\n\n') }] : base;

          // History-bound models: append-only. Old tool results are cleared
          // server-side (providerOptions above), and the last step keeps the
          // tools array — toolChoice 'none' makes the providers drop it — and
          // instead appends an instruction after the latest tool results.
          if (historyBound) {
            return { messages: withCacheBreakpoint(withNotes(messages), conversationCacheMarker) };
          }

          // TASK 2: compress tool results from steps older than the threshold
          // so large list/read payloads don't accumulate at full size in the
          // context that's resent on every turn. The trace (onStep /
          // result.steps) keeps the uncompressed (size-trimmed) results; only
          // the in-flight model context is shrunk. Only compress when there's enough history
          // to be worth it — the most recent RESULT_SUMMARY_THRESHOLD steps
          // stay at full fidelity.
          const compressedMessages = compressOldToolMessages(messages, steps.length, { recall: 'recall_objects' in tools });

          // TASK 3: force text-only on the final allowed step. Phase 2: a
          // worker instead forces its wrap-up tool (report_result) on that
          // step so the loop always ends with a structured result rather than
          // free text (Requirement 4.6). Single-agent runs leave
          // forceFinalTool unset, so they keep forcing 'none' exactly as
          // before.
          const lastStepToolChoice = ctx.forceFinalTool
            ? ({ type: 'tool', toolName: ctx.forceFinalTool } as const)
            : ('none' as const);
          return {
            toolChoice: isLastStep ? lastStepToolChoice : 'auto',
            messages: withCacheBreakpoint(withNotes(compressedMessages ?? messages), conversationCacheMarker),
          };
        },
        // TASK 8: fire onStep callback after each step so the route can stream it
        onStepEnd: (step) => {
          const stepNumber = stepIndex++;
          const trace = toStepTrace(step, stepNumber);
          budget.recordStep(
            step.usage,
            step.toolCalls.map((c) => effectiveToolCall(c.toolName, c.input))
          );
          // Only calls that actually ran count — a denied call never executed.
          for (const part of step.content) {
            if (part.type !== 'tool-result' && part.type !== 'tool-error') continue;
            if (classifyTool(effectiveToolCall(part.toolName, part.input).toolName) !== 'read') attemptHadSideEffects = true;
          }
          // Item #8: record a trace span for this step from what the SDK reports.
          recordStepSpan(tracer, step, stepNumber, resolvedModelKey);
          if (ctx.onToolOutcome) {
            for (const outcome of toolOutcomes(step.content, approvalReasons)) ctx.onToolOutcome(outcome);
          }
          ctx.onStep?.(trace);
        },
      });

      // Drain the stream, forwarding assistant text as it arrives. Reasoning
      // (thinking) deltas are intentionally not forwarded — they're hidden by
      // default on current models. Errors during streaming surface when the
      // terminal promises below are awaited, so they still reach the fallback
      // try/catch as a rejection rather than being swallowed here.
      if (ctx.onTextDelta) {
        for await (const part of stream.fullStream) {
          if (part.type === 'text-delta') ctx.onTextDelta(part.text);
        }
      }

      // Same shape generateText returned, so nothing downstream changes.
      // Awaiting these also drives the loop to completion when onTextDelta
      // isn't set (no fullStream consumer) and rejects on a provider failure.
      const [text, steps, finishReason, usage] = await Promise.all([
        stream.text,
        stream.steps,
        stream.finishReason,
        stream.usage,
      ]);
      return { text, steps, finishReason, usage };
    });
  };

  let resolvedModelKey = startModelKey || getDefaultModelKey();
  if (!isPinned && modelHealth.isUnhealthy(resolvedModelKey)) {
    const healthy = modelHealth.pickFallback(resolvedModelKey, registry);
    if (healthy) resolvedModelKey = healthy;
  }

  // Finish the current attempt's trace and export it (best-effort). Called once
  // the run settles — on success with the run's totals, on failure with the
  // error. exportSpans never throws, so this can't disturb the run.
  const finishTrace = (extra: { attributes?: Record<string, AttrValue>; error?: string }): void => {
    try {
      const spans = tracer.finish({
        attributes: {
          'harness.model.key': resolvedModelKey,
          'harness.step.count': stepIndex,
          ...extra.attributes,
        },
        ...(extra.error ? { error: extra.error } : {}),
      });
      void exportSpans(spans);
    } catch (err) {
      console.error('[tracing] failed to finish/export run trace:', err instanceof Error ? err.message : err);
    }
  };

  const tried = new Set<string>();
  let result: Awaited<ReturnType<typeof callModel>> | undefined;

  // Concurrency cap (Requirement 13.1, 13.2): take one of the process-wide
  // agent-loop slots before the first model call and release it in `finally`,
  // whatever ends the loop — success, a thrown provider failure, a side-effect
  // refusal or an abort. A worker that can't get a slot queues FIFO here; an
  // abort while queued rejects before any model call runs.
  const releaseSlot = await acquireLoopSlot(abortSignal);
  try {
    for (;;) {
      tried.add(resolvedModelKey);
      try {
        result = await callModel(resolvedModelKey);
        modelHealth.recordSuccess(resolvedModelKey);
        break;
      } catch (err) {
        if (abortSignal?.aborted) {
          finishTrace({ error: 'aborted', attributes: { 'harness.aborted': true } });
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        const failureKind = classifyProviderFailure(message);
        if (failureKind) modelHealth.recordFailure(resolvedModelKey);
        const fallback =
          !isPinned && failureKind ? modelHealth.pickFallback(resolvedModelKey, registry, tried) : null;
        if (!fallback) {
          finishTrace({ error: message });
          throw err;
        }
        // A fallback restarts the whole run. If this attempt already ran a
        // write/destructive tool, the new model would redo it — fail instead.
        if (attemptHadSideEffects) {
          const sideEffectErr =
            `${message}\n(Not falling back to "${fallback}": the failed attempt on "${resolvedModelKey}" ` +
            `already executed write/destructive tool calls, which a restarted run would repeat.)`;
          finishTrace({ error: sideEffectErr });
          throw new Error(sideEffectErr);
        }
        console.warn(
          `[agent] model "${resolvedModelKey}" hit a provider ${failureKind} failure; ` +
            `falling back to same-tier "${fallback}".`
        );
        ctx.onRestart?.({ fromModelKey: resolvedModelKey, toModelKey: fallback });
        resolvedModelKey = fallback;
      }
    }

    if (!result) throw new Error('unreachable: chat model call produced no result');

    const steps = result.steps.map((step, i) => toStepTrace(step, i));

    const budgetUsage = budget.usage();
    // Item #8: finish the run trace with the run's totals (best-effort).
    finishTrace({
      attributes: {
        'gen_ai.response.finish_reasons': result.finishReason,
        'harness.usage.total_tokens': budgetUsage.tokens,
        'harness.duration_ms': budgetUsage.durationMs,
        ...(budgetUsage.costUsd !== undefined ? { 'harness.cost_usd': budgetUsage.costUsd } : {}),
        ...(stopReason ? { 'harness.stop_reason': stopReason } : {}),
      },
    });

    return {
      text: result.text,
      steps,
      finishReason: result.finishReason,
      modelKey: resolvedModelKey,
      ...(stopReason ? { stopReason } : {}),
      budgetUsage,
      usage: toTokenUsage(result.usage),
      hadSideEffects: attemptHadSideEffects,
    };
  } finally {
    releaseSlot();
  }
}
