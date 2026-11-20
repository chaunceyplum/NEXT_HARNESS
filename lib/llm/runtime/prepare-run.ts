/**
 * Setup half of a run: routing, Launch mode, tool selection, memory,
 * planning and the approval hook. See prepareRun.
 */

import { type ToolSet } from 'ai';
import { getDefaultModelKey } from '../models/model-registry';
import { getMcpToolCatalog, createRagJudgmentSink, type RagJudgmentSink } from '../tools/tool-catalog';
import { effectiveToolCall } from '../tools/tool-discovery';
import { stage, type PreparedRun, type EarlyResult, type ToolApprovalFn } from './agent-core';
import { defaultModelHealth } from '../models/model-health';
import { resolvePolicy } from '../tools/tool-policy';
import { listFacts, memoryEnabled, memoryPreamble } from '../../memory-store';
import { buildPlanTools, makePlan, planPreamble, PlanTracker } from './planner';
import { resolveDomains, startDomainSessions } from '../domains';
import { planningContext, PLANNING_RAG_TOOL, retrieveForPlanning, type PlanningRetrieval } from './planning-retrieval';
import { AUTO_MODEL, routeRequest, type RouteDecision } from '../models/model-router';
import { resolveBudget } from './run-budget';
import {
  approvalReason,
  APPROVAL_REASON_TEXT,
  resolveRolloutMode,
  type ApprovalReason,
} from '../tools/approval-policy';
import { orchestrationRequested } from './coordinator';
import { orchestrationFlag } from './orchestration-config';
import { type AttrValue } from '../../tracing';
import { promptVersion, toolsetVersion, appVersion } from '../../version';
import { type RunAgentOptions } from './agent-options';
import { selectLiveTools } from './tool-selection';
import { rememberFactTool } from './step-trace';
import { ObjectLedger, objectLedgerEnabled, recallObjectsTool, withObjectLedger } from '../tools/object-ledger';
import { promptOptionsFor } from './agent-core';

// ── Main agent loop ───────────────────────────────────────────────────────────

/**
 * Setup half of a run (Requirement 1.1): routing, Launch mode resolution,
 * validation gate creation, Launch brief parsing, tool selection, memory
 * loading, planning retrieval, planning, plan approval and the approval hook.
 *
 * Returns an {@link EarlyResult} when setup itself produced the final answer —
 * an unclear routed request (a clarifying question) or a denied plan — so no
 * model loop runs. Otherwise returns a {@link PreparedRun} carrying the
 * {@link LoopContext} executeLoop() needs plus the extra fields runAgent()
 * folds into the AgentRunResult (toolsConsidered, plan, route, versions,
 * planning retrieval and the RAG judgment sink).
 *
 * This is a behaviour-preserving extraction of the first half of the old
 * single runAgent(); nothing here changed except the two early returns now
 * come back wrapped as EarlyResult.
 */
export async function prepareRun(opts: RunAgentOptions): Promise<PreparedRun | EarlyResult> {
  const {
    userInput,
    maxSteps = 20,
    toolShortlistSize = 24,
    toolRetries = 1,
    modelHealth = defaultModelHealth,
  } = opts;

  // Model routing (model-router.ts): "auto" picks a tier per request. A
  // routed model isn't pinned, so the same-tier fallback still applies.
  let modelKey = opts.modelKey;
  let route: RouteDecision | undefined;
  if (modelKey === AUTO_MODEL) {
    route = await routeRequest(userInput, { health: modelHealth });
    opts.onRoute?.(route);
    if (route.category === 'unclear' && route.clarifyingQuestion) {
      // Don't guess at an unclear request: ask instead of running tools.
      return {
        kind: 'early',
        result: {
          finalText: route.clarifyingQuestion,
          steps: [],
          toolsConsidered: [],
          finishReason: 'stop',
          modelKey: route.modelKey,
          budgetUsage: { tokens: 0, costUsd: 0, durationMs: 0 },
          usage: {},
          ragJudgments: [],
          route,
        },
      };
    }
    modelKey = undefined;
  }
  const startModelKey = route?.modelKey ?? modelKey;

  let tools: ToolSet;
  let toolsConsidered: string[];
  let userMessage = userInput;
  const rolloutMode = resolveRolloutMode(opts.rolloutMode);
  // Launch-tagging run: grounds the prompt (buildSystemMessage), seeds the plan
  // from the Launch template, and widens tool selection to the Reactor tools
  // (both via launch-plan.ts). Explicit opts.launchMode wins; otherwise it's
  // inferred from a Launch/Reactor platform filter.
  // Segment/audience run: grounds the prompt with the PQL reference + glossary
  // and keeps the field lookup + segment tools always on (segmentsPack).
  // Both are domain packs (lib/llm/domains); an explicit flag wins over inference.
  const domains = resolveDomains({ userInput, platformFilter: opts.platformFilter, launchMode: opts.launchMode, segmentMode: opts.segmentMode });
  const launchMode = domains.launch;
  const segmentMode = domains.segments;
  // A Launch run started with a publishTarget may publish the populated
  // library to a dev/staging environment. This flag swaps the grounding to
  // the publish state machine, widens the seed plan + always-on tools to the
  // publish pipeline, and feeds the gate the fallback target. Off → every
  // publish-related path is byte-identical to today.
  const publishEnabled =
    launchMode && Boolean(opts.publishTarget?.environmentId || opts.publishTarget?.environmentName);
  // Collects fire-and-forget RAG judgments for live runs; drained once the
  // loop finishes. The eval path (opts.tools) doesn't judge, so it keeps no
  // sink — there's nothing to drain and no judgments to persist there.
  let ragJudgmentSink: RagJudgmentSink | undefined;
  let planningRetrieval: PlanningRetrieval | undefined =
    opts.knowledge === undefined
      ? undefined
      : { tool: PLANNING_RAG_TOOL, query: userInput, context: planningContext(opts.knowledge) };
  // Domain sessions (lib/llm/domains): each active pack's per-run setup. A
  // Launch run parses the brief into typed requirements, builds its
  // validation gate and picks worked examples (live runs only), and supplies
  // the shortlist query and the seeded plan. The eval path (opts.tools) is not
  // live, so it gets no gate, no parse and no examples.
  const resolvedPolicy = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const session = await startDomainSessions(domains, {
    userInput,
    modelKey: startModelKey,
    live: !opts.tools,
    publishEnabled,
    dryRun: resolvedPolicy.dryRun,
    shadow: rolloutMode === 'shadow',
    ...(opts.publishTarget ? { publishTarget: opts.publishTarget } : {}),
    ...(opts.requirements ? { requirements: opts.requirements } : {}),
  });
  const toolGate = session.toolGate;

  if (opts.tools) {
    // Evals pass opts.tools and bypass the tool policy so scripted tool
    // fixtures aren't accidentally filtered.
    tools = opts.tools;
    toolsConsidered = Object.keys(opts.tools);
  } else {
    ragJudgmentSink = createRagJudgmentSink();
    // Kick off the memory fetch in parallel with tool selection — both are
    // network calls and neither depends on the other's result.
    const liveFetch = selectLiveTools(
      userInput,
      toolShortlistSize,
      toolRetries,
      { mode: opts.policy, dryRun: opts.dryRun, dryRunWrites: rolloutMode === 'shadow' },
      ragJudgmentSink,
      opts.platformFilter,
      { active: domains, publishEnabled, shortlistQuery: session.shortlistQuery, toolGate }
    );
    const memoryFetch = memoryEnabled()
      ? listFacts().catch((err) => {
          console.warn('[agent] Memory unavailable; running without it:', err instanceof Error ? err.message : err);
          return null;
        })
      : Promise.resolve(null);

    // Planning-stage retrieval (planning-retrieval.ts): the run's one
    // up-front knowledge lookup, shared by the planner and the executor.
    // Skipped when the caller supplied the excerpts (opts.knowledge).
    const groundingQuery = session.shortlistQuery ?? userInput;
    const lookup = () =>
      stage('planning knowledge lookup', async () =>
        retrieveForPlanning(groundingQuery, {
          available: new Set((await getMcpToolCatalog()).map((t) => t.name)),
          sink: ragJudgmentSink,
          abortSignal: opts.abortSignal,
        })
      ).catch((err) => {
        console.warn('[agent] Planning knowledge lookup failed; running without it:', err instanceof Error ? err.message : err);
        return undefined;
      });
    const groundingFetch = planningRetrieval ? Promise.resolve(planningRetrieval) : lookup();

    const [live, facts, grounding] = await Promise.all([liveFetch, memoryFetch, groundingFetch]);
    tools = live.tools;
    toolsConsidered = live.toolsConsidered;
    planningRetrieval = grounding;

    // Deployment memory (memory-store.ts): stored facts lead the first message,
    // and remember_fact saves new ones (not in read-only runs).
    if (facts) {
      userMessage = memoryPreamble(facts) + userInput;
    }
    if (memoryEnabled() && resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun }).mode !== 'read-only') {
      tools = { ...tools, remember_fact: rememberFactTool(opts.runId, opts.actor) };
    }
  }

  // Object ledger (object-ledger.ts): every id a tool result shows is kept
  // for the whole run, outside the context that compression and server-side
  // clearing shrink, and recall_objects reads it back. Both paths (live and
  // eval) get it, so evals exercise what production runs do.
  const objectLedger = objectLedgerEnabled() ? new ObjectLedger() : undefined;
  if (objectLedger) {
    tools = { ...withObjectLedger(tools, objectLedger), recall_objects: recallObjectsTool(objectLedger) };
  }

  // Plan-and-execute (planner.ts): plan first, optionally have a person
  // approve it, then execute with update_plan / revise_plan available.
  // Requirement 2.6: a run that asks for orchestration needs a plan for the
  // coordinator to schedule, so planning is forced on (as if planFirst) when
  // orchestration could actually run — unless the flag is off, where the
  // request's orchestrate option is ignored entirely (Requirement 2.2).
  const planFirst = opts.planFirst || orchestrationRequested(orchestrationFlag(), opts.orchestrate) || Boolean(opts.resumePlan);
  let planTracker: PlanTracker | undefined;
  if (planFirst) {
    const planModel = startModelKey || getDefaultModelKey();
    if (opts.resumePlan) {
      // Continue the interrupted run's plan rather than planning again.
      planTracker = new PlanTracker(structuredClone(opts.resumePlan.plan), (p) => opts.onPlan?.(p));
    } else if (session.seedPlan) {
      // A domain with a fixed backbone seeds the plan instead of asking the
      // model (Launch: read property state -> ground against the KB ->
      // generate -> validate -> populate the library, specialised with the
      // parsed requirements).
      planTracker = new PlanTracker(session.seedPlan, (p) => opts.onPlan?.(p));
    } else {
      try {
        const plan = await stage(`planner call (${planModel})`, () =>
          makePlan(userInput, Object.keys(tools), planModel, planningRetrieval?.context)
        );
        planTracker = new PlanTracker(plan, (p) => opts.onPlan?.(p));
      } catch (err) {
        console.warn('[agent] Planning failed; running without a plan:', err instanceof Error ? err.message : err);
      }
    }
    if (planTracker) {
      opts.onPlan?.(planTracker.plan);
      if (opts.approvePlan) {
        const decision = await opts.approvePlan(planTracker.plan);
        if (!decision.approved) {
          return {
            kind: 'early',
            result: {
              finalText: `The plan wasn't approved${decision.reason ? ` (${decision.reason})` : ''}, so nothing was run.`,
              steps: [],
              toolsConsidered,
              finishReason: 'stop',
              modelKey: planModel,
              budgetUsage: { tokens: 0, costUsd: 0, durationMs: 0 },
              usage: {},
              ragJudgments: ragJudgmentSink ? await ragJudgmentSink.drain() : [],
              plan: planTracker.plan,
            },
          };
        }
      }
      tools = { ...tools, ...buildPlanTools(planTracker) };
      userMessage = `${planPreamble(planTracker.plan)}\n\nRequest: ${userMessage}`;
    }
  }

  if (planningRetrieval) userMessage = `${planningRetrieval.context}\n\n${userMessage}`;

  // A domain's message preamble leads the request (Launch, Phase 5: the
  // known-good rule/data-element examples closest to the parsed requirements,
  // so generation pattern-matches validated shapes). Live runs only.
  if (session.messagePreamble) userMessage = `${session.messagePreamble}\n\n${userMessage}`;

  // TASK 9: gate risky calls on a human decision (live runs only).
  // opts.tools marks the eval path, which bypasses gating — UNLESS opts.approveTool
  // is explicitly provided so the eval can exercise the approval gate itself.
  const approvalReasons = new Map<string, ApprovalReason>();
  const { dryRun } = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const toolApproval = (opts.tools && !opts.approveTool)
    ? undefined
    : async ({ toolCall, workerId }: Parameters<ToolApprovalFn>[0]) => {
        const call = effectiveToolCall(toolCall.toolName, toolCall.input);
        // An outbound call the domain session verified is exempt from the
        // outbound gate (Launch: a publish transition whose target is a
        // server-verified dev/staging environment; production and unknown
        // stages stay gated, and production is refused by the gate before it
        // runs). Only live Launch runs verify anything.
        const verifiedOutbound = session.verifiesOutbound?.(call.toolName, call.input) === true;
        const reason = approvalReason(call.toolName, call.input, { mode: rolloutMode, dryRun, verifiedOutbound });
        if (!reason) return 'not-applicable' as const;
        approvalReasons.set(toolCall.toolCallId, reason);
        if (!opts.approveTool) {
          return {
            type: 'denied' as const,
            reason: `This call needs a human approver (${APPROVAL_REASON_TEXT[reason]}), and none is attached to this run.`,
          };
        }
        const decision = await opts.approveTool({ toolCallId: toolCall.toolCallId, ...call, reason, ...(workerId ? { workerId } : {}) });
        return { type: decision.approved ? ('approved' as const) : ('denied' as const), reason: decision.reason };
      };

  // Version fingerprints for this run (lib/version.ts). promptVersion is built
  // from the same flags the loop builds the prompt from (promptOptionsFor), so
  // the fingerprint always matches the prompt the model actually got.
  const versions = {
    prompt: promptVersion(promptOptionsFor(tools, { launchMode, publishEnabled, segmentMode })),
    toolset: toolsetVersion(
      Object.entries(tools).map(([name, t]) => ({ name, description: (t as { description?: string }).description }))
    ),
    app: appVersion(),
  };

  // Base attributes for the run trace span (item #8). executeLoop builds a
  // fresh RunTracer from these per model attempt, so a same-tier fallback's
  // abandoned steps don't leak into the exported trace.
  const baseTracerAttrs: Record<string, AttrValue> = {
    'harness.prompt.version': versions.prompt,
    'harness.toolset.version': versions.toolset,
    'harness.app.version': versions.app,
    ...(opts.runId ? { 'harness.run.id': opts.runId } : {}),
  };

  return {
    kind: 'prepared',
    ctx: {
      tools,
      launchMode,
      publishEnabled,
      segmentMode,
      userMessage,
      startModelKey,
      // A pinned model (opts.modelKey, not "auto"/routed) disables same-tier fallback.
      isPinned: Boolean(modelKey),
      maxSteps,
      budgetLimits: resolveBudget(opts.budget),
      modelHealth,
      ...(toolApproval ? { toolApproval } : {}),
      approvalReasons,
      // Phase 3 (workers): the run's single gate (Requirement 9.1). Already
      // embedded in `tools`; carried on the ctx so the coordinator hands the
      // same instance to every worker.
      ...(toolGate ? { toolGate } : {}),
      ...(objectLedger ? { objectLedger } : {}),
      baseTracerAttrs,
      ...(opts.thinkingBudget !== undefined ? { thinkingBudget: opts.thinkingBudget } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
      ...(opts.onTextDelta ? { onTextDelta: opts.onTextDelta } : {}),
      ...(opts.onToolOutcome ? { onToolOutcome: opts.onToolOutcome } : {}),
      ...(opts.onRestart ? { onRestart: opts.onRestart } : {}),
    },
    toolsConsidered,
    ...(planTracker ? { planTracker } : {}),
    ...(route ? { route } : {}),
    versions,
    ...(planningRetrieval ? { planningRetrieval } : {}),
    ...(ragJudgmentSink ? { ragJudgmentSink } : {}),
  };
}
