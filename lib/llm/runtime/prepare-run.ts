/**
 * Setup half of a run: routing, Launch mode, tool selection, memory,
 * planning and the approval hook. See prepareRun.
 */

import { type ToolSet } from 'ai';
import { getDefaultModelKey } from '../models/model-registry';
import { getMcpToolCatalog, createRagJudgmentSink, type RagJudgmentSink } from '../tools/tool-catalog';
import { effectiveToolCall } from '../tools/tool-discovery';
import { stage, type LoopContext, type PreparedRun, type EarlyResult, type ToolApprovalFn } from './agent-core';
import { defaultModelHealth } from '../models/model-health';
import { resolvePolicy } from '../tools/tool-policy';
import { listFacts, memoryEnabled, memoryPreamble } from '../../memory-store';
import { buildPlanTools, makePlan, planPreamble, PlanTracker } from './planner';
import { launchShortlistQuery, seedLaunchPlan } from '../domains/launch/plan';
import { resolveSegmentMode } from '../domains/segments/context';
import { launchExamplesPreamble, selectLaunchExamples } from '../domains/launch/examples';
import { planningContext, PLANNING_RAG_TOOL, retrieveForPlanning, type PlanningRetrieval } from './planning-retrieval';
import { LaunchValidationGate, PUBLISH_TRANSITION_TOOL } from '../domains/launch/validation';
import { parseLaunchBrief } from '../domains/launch/brief';
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

/** The PLATFORM_GROUPS key for Launch/Reactor tags — a platformFilter narrowed to it turns Launch mode on. */
const LAUNCH_PLATFORM_GROUP = 'Tags (Reactor)';
/** Groups that may ride along with the Launch group without making the run "not Launch" (grounding + the code-commit handoff). */
const LAUNCH_COMPANION_GROUPS = new Set(['Knowledge', 'GitHub']);

/**
 * Whether this run should ground on the Launch/Reactor object model: set
 * explicitly via opts.launchMode, or implied when the platform filter is
 * narrowed to the Launch/Reactor tag tools (plus Knowledge/GitHub). A filter
 * that merely still includes the Tags group alongside other platforms — e.g.
 * every box ticked but CJA — is not a Launch run. Non-Launch runs keep the
 * lean cached prefix.
 */
export function resolveLaunchMode(opts: Pick<RunAgentOptions, 'launchMode' | 'platformFilter'>): boolean {
  if (opts.launchMode !== undefined) return opts.launchMode;
  const filter = opts.platformFilter ?? [];
  return filter.includes(LAUNCH_PLATFORM_GROUP) && filter.every((p) => p === LAUNCH_PLATFORM_GROUP || LAUNCH_COMPANION_GROUPS.has(p));
}


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
  const launchMode = resolveLaunchMode(opts);
  // Segment/audience run: grounds the prompt with the PQL reference + glossary
  // and keeps the field lookup + segment tools always on (segment-context.ts).
  const segmentMode = resolveSegmentMode(opts, userInput);
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
  // Phase 4: the validation gate for a Launch-mode run (launch-validation.ts).
  // It observes tool results to build property state and BLOCKS the library
  // handoff until the structural / reference / dry-run checks pass. Non-Launch
  // runs (and the eval path) get none, so the gate wrapper is a no-op there.
  const resolvedPolicy = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const launchGate =
    launchMode && !opts.tools
      ? new LaunchValidationGate({ dryRun: resolvedPolicy.dryRun, shadow: rolloutMode === 'shadow', publishTarget: opts.publishTarget })
      : undefined;

  // Phase 2: parse the free-text brief into typed requirements for a live
  // Launch run, so the shortlist query, the seeded plan and the few-shot
  // examples are specialised to it. Callers can pass opts.requirements to skip
  // the parse; the eval path (opts.tools) doesn't parse. Fail-open: a parse
  // failure runs the generic Launch flow rather than failing the run.
  let requirements = opts.requirements;
  if (launchMode && !opts.tools && !requirements) {
    try {
      requirements = await stage('Launch brief parse', () => parseLaunchBrief(userInput, startModelKey));
    } catch (err) {
      console.warn('[agent] Launch brief parse failed; running without parsed requirements:', err instanceof Error ? err.message : err);
    }
  }

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
      { enabled: launchMode, publishEnabled, requirements, gate: launchGate },
      segmentMode
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
    const groundingQuery = launchMode ? launchShortlistQuery(userInput, requirements) : userInput;
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
    } else if (launchMode) {
      // Launch-tagging runs follow a fixed grounding backbone (read property
      // state -> ground against the KB -> generate -> validate -> populate the
      // library), so the plan is seeded deterministically from the Launch
      // template (launch-plan.ts) and specialised with the Phase 2
      // requirements, rather than asked of the model.
      planTracker = new PlanTracker(seedLaunchPlan(requirements, publishEnabled), (p) => opts.onPlan?.(p));
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

  // Phase 5: few-shot grounding. The agent's only knowledge base is the
  // MCP-owned search_adobe_knowledge, which this repo can't seed, so a small
  // curated set of known-good rule/data-element example documents lives in
  // launch-examples.ts. Retrieve the ones closest to the Phase 2 requirements
  // and inject them ahead of the request, so the generation step pattern-matches
  // against validated shapes rather than inventing delegate/settings layouts.
  // Live Launch runs only (the eval path passes opts.tools); nothing to show
  // when no requirements were parsed or none overlap.
  if (launchMode && !opts.tools) {
    const preamble = launchExamplesPreamble(selectLaunchExamples(requirements));
    if (preamble) userMessage = `${preamble}\n\n${userMessage}`;
  }

  // TASK 9: gate risky calls on a human decision (live runs only).
  // opts.tools marks the eval path, which bypasses gating — UNLESS opts.approveTool
  // is explicitly provided so the eval can exercise the approval gate itself.
  const approvalReasons = new Map<string, ApprovalReason>();
  const { dryRun } = resolvePolicy({ mode: opts.policy, dryRun: opts.dryRun });
  const toolApproval = (opts.tools && !opts.approveTool)
    ? undefined
    : async ({ toolCall, workerId }: Parameters<ToolApprovalFn>[0]) => {
        const call = effectiveToolCall(toolCall.toolName, toolCall.input);
        // A publish transition's exemption from the outbound gate is decided
        // from the gate's server-truth stage (launch-validation.ts): a verified
        // dev/staging target is not gated, production/unknown stay gated (and
        // production is independently refused by the gate before it runs). The
        // gate exists only on live Launch runs; otherwise no stage is passed
        // and behaviour is unchanged.
        const transitionStage =
          launchGate && call.toolName === PUBLISH_TRANSITION_TOOL ? launchGate.resolveStageFor(call.input) : undefined;
        const reason = approvalReason(call.toolName, call.input, { mode: rolloutMode, dryRun, transitionStage });
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

  // Version fingerprints for this run (lib/version.ts). promptVersion matches
  // how the prompt is actually built: live runs include the find_tools rule.
  const toolDiscovery = 'find_tools' in tools;
  const versions = {
    prompt: promptVersion({ toolDiscovery, memory: 'remember_fact' in tools, launchMode, publishEnabled, segmentMode }),
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
      ...(launchGate ? { launchGate } : {}),
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
