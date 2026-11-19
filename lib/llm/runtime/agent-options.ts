/** Options and result types for runAgent (lib/llm/runtime/agent.ts). */

import { type ToolSet } from 'ai';
import { type RagJudgmentEntry } from '../tools/tool-catalog';
import { type AgentStepTrace, type TokenUsage, type ToolOutcome } from './agent-core';
import { ModelHealthTracker } from '../models/model-health';
import { type PolicyMode } from '../tools/tool-policy';
import { type Plan } from './planner';
import type { LaunchRequirements } from '../domains';
import { type RouteDecision } from '../models/model-router';
import { type BudgetStopReason, type BudgetUsage, type RunBudgetLimits } from './run-budget';
import { type ApprovalReason, type RolloutMode } from '../tools/approval-policy';
import type { ResumePlan } from '../../types';
import type { WorkerRecord } from './worker';

export interface AgentRunResult {
  finalText: string;
  steps: AgentStepTrace[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
  /** Model registry key that actually produced the result. Differs from the requested one after a same-tier fallback. */
  modelKey: string;
  /**
   * Set when a run budget or loop detection cut the run short (run-budget.ts).
   * The final text is then a wrap-up of partial work, not a finished answer.
   */
  stopReason?: BudgetStopReason;
  /** Tokens, estimated cost, and wall-clock time the successful attempt used. */
  budgetUsage: BudgetUsage;
  /**
   * Quality judgments for a sample of the knowledge searches this run made,
   * scored off the critical path by the fire-and-forget RAG judge
   * (lib/llm/quality/rag-judge.ts) and drained once the loop finished. Monitoring
   * data the agent didn't act on — persisted with the run record. Empty when
   * nothing was sampled, judging is disabled, or the eval path was used.
   */
  ragJudgments: RagJudgmentEntry[];
  /**
   * Version fingerprints for this run (lib/version.ts), so a stored trace or
   * score can be tied to the exact prompt, tool set and build it came from.
   */
  /** Absent when the run ended before any model call (an unclear request, a denied plan). */
  versions?: {
    /** sha256(system prompt), first 12 hex — matches the eval's promptVersion. */
    prompt: string;
    /** sha256(sorted tool name+description lines), first 12 hex. */
    toolset: string;
    /** GIT_SHA / APP_VERSION / package version, or 'dev'. */
    app: string;
  };
  /** The plan as executed (statuses and revisions included), when planFirst was set. */
  plan?: Plan;
  /** Set when the request asked for model "auto": how the model was chosen. */
  route?: RouteDecision;
  /**
   * Orchestrator-worker fields (lib/llm/runtime/coordinator.ts). `orchestrated` is
   * true when the coordinator ran the plan as concurrent workers instead of a
   * single agent loop; `workers` are those workers' records and `replans`
   * counts the replanning calls made. Absent / false for single-agent runs, so
   * their result shape is unchanged. (Re-homed to lib/types.ts in Task 8.1.)
   */
  orchestrated?: boolean;
  replans?: number;
  workers?: WorkerRecord[];
}

export interface RunAgentOptions {
  userInput: string;
  /**
   * Persisted run id (from the route). Recorded on the trace's run span as
   * `harness.run.id` so a trace can be correlated with the stored run and its
   * replay view, and on facts the run saves to memory. Omit (e.g. the eval
   * path) and the trace still works.
   */
  runId?: string;
  /** Model registry key, e.g. "anthropic:haiku". Defaults to DEFAULT_MODEL env var. */
  modelKey?: string;
  /** Tool-call round trips before the loop is forced to stop. */
  maxSteps?: number;
  /** How many tools the semantic shortlist pulls in, on top of the always-on set. */
  toolShortlistSize?: number;
  /** Extra attempts after a transient (5xx/timeout/429) tool failure, with back-off. 0 disables retrying. */
  toolRetries?: number;
  /**
   * Health tracker used to route around models failing on provider-side access/auth/quota errors.
   * Defaults to the process-wide tracker; inject a fresh one in tests.
   */
  modelHealth?: ModelHealthTracker;
  /**
   * A pre-built tool set to hand the model instead of shortlisting from the live MCP catalog.
   * Used by the agent eval (evals/agent.eval.ts) to grade the real loop against scripted tools.
   * Not exposed via /api/build.
   */
  tools?: ToolSet;
  /**
   * A knowledge-search result to use as the planning-stage excerpts instead
   * of a live lookup (planning-retrieval.ts). Used by the evals, whose
   * scripted runs make no live lookup. Not exposed via /api/build.
   */
  knowledge?: unknown;
  /**
   * TASK 8 (streaming): called after each agent step completes with the
   * partial trace for that step. Allows the route to stream step events to
   * the client as they arrive rather than waiting for the full run to finish.
   */
  onStep?: (step: AgentStepTrace, workerId?: string) => void;
  /**
   * TASK 1 (token streaming): called with each chunk of assistant text as the
   * model generates it, so the route can stream the answer to the client token
   * by token instead of only revealing it once the step finishes. The concrete
   * win is the final written answer rendering as it's produced; intermediate
   * steps are usually short text plus a tool call. Reasoning/thinking tokens
   * are NOT forwarded here (they're hidden by default on current models). Text
   * for a given step is also still delivered in full via onStep.
   */
  onTextDelta?: (delta: string) => void;
  /**
   * TASK 9: Tool policy to apply before handing the tool set to the model.
   * 'read-only' removes all write and destructive tools structurally —
   * the model cannot call them at all, not just rule-based.
   * Can only tighten BUILD_POLICY: BUILD_POLICY=read-only wins over 'full' here.
   */
  policy?: PolicyMode;
  /**
   * TASK 9: When true, wraps destructive tools to return a dry-run description
   * instead of executing. Can only tighten TOOL_DRY_RUN: false here does not
   * override TOOL_DRY_RUN=true.
   */
  dryRun?: boolean;
  /**
   * Rollout stage (approval-policy.ts): 'assisted' asks before every write,
   * 'shadow' dry-runs every write. Can only tighten ROLLOUT_MODE.
   */
  rolloutMode?: RolloutMode;
  /**
   * TASK 10: Enable extended thinking (Claude via Anthropic / Bedrock only).
   * Ignored for other providers and non-Claude Bedrock models.
   *
   * Minimum 1 024 tokens. On Haiku 4.5 and older Claude models this is the
   * thinking token budget (8 000–16 000 is a good start for multi-step
   * tasks). Newer models (Sonnet 5, Opus 4.7+, Opus 5.x) reject fixed budgets,
   * so there it just switches on adaptive thinking and the value is unused.
   *
   * Can also be set globally via THINKING_BUDGET_TOKENS env var (number).
   * Per-request value takes precedence over the env var.
   */
  thinkingBudget?: number;
  /**
   * Restrict the tool catalog to tools belonging to these platforms only. Each
   * entry is a key from PLATFORM_GROUPS (lib/llm/tools/tool-catalog.ts). Omit or
   * leave empty to include all platforms.
   */
  platformFilter?: string[];
  /**
   * Launch-tagging run: inject the Launch/Reactor object-model contract into
   * the cached system-prompt prefix (agent-core.ts). Omit to infer it from
   * platformFilter targeting the Launch/Reactor group; set false to force the
   * lean prefix even then. The deliverable stops at a populated library — there
   * is no publish-to-environment tool.
   */
  launchMode?: boolean;
  /**
   * Segment/audience grounding (segment-context.ts): the PQL reference, the
   * business glossary and the real-fields-only rules in the system prompt,
   * plus the field-lookup and segment tools always on. Unset → inferred from
   * a request that mentions segments, audiences or PQL; false forces it off.
   */
  segmentMode?: boolean;
  /**
   * Publish target for a Launch run (lib/types.ts RunRequest.publishTarget).
   * ABSENT → the run stops at a populated library (byte-identical to today).
   * PRESENT → the run may publish the library, but ONLY to a development or
   * staging environment (resolved from server truth); a production or
   * unresolvable stage is refused in code (launch-validation.ts). Only takes
   * effect on a Launch run (publishEnabled = launchMode && Boolean(publishTarget)).
   */
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string };
  /**
   * Parsed Launch requirements (launch-brief.ts) for a Launch-tagging run.
   * When present on a Launch-mode run they feed BOTH the tool shortlist query
   * (so the right Reactor tools get ranked, see launch-plan.ts) AND the seeded
   * plan (so the template names the real property/library/tag counts). Ignored
   * outside Launch mode.
   */
  requirements?: LaunchRequirements;
  /** Per-request run limits (tokens, cost, time, identical calls). Can only tighten the RUN_* env limits. */
  budget?: Partial<RunBudgetLimits>;
  /** Requesting user, recorded on facts the run saves to memory. */
  actor?: string;
  /** Plan before acting (planner.ts). */
  planFirst?: boolean;
  /**
   * Resuming an orchestrated run (Requirement 12.4): the stored plan (done
   * steps kept, the rest pending) and the done steps' WorkerResults. Used as
   * the run's plan instead of planning again; the coordinator starts with
   * these results so only the unfinished steps run.
   */
  resumePlan?: ResumePlan;
  /** Called with the plan when it's made and whenever a step's status or the plan changes. */
  onPlan?: (plan: Plan) => void;
  /** Ask a person to approve the plan before anything runs. A denial ends the run without tool calls. */
  approvePlan?: (plan: Plan) => Promise<{ approved: boolean; reason?: string }>;
  /** Called once with the routing decision when modelKey is "auto". */
  onRoute?: (route: RouteDecision) => void;
  /** Aborts the run (model calls and the step loop) — wired to the client disconnecting / hitting Stop. */
  abortSignal?: AbortSignal;
  /**
   * Called when a provider failure makes the run restart from scratch on a
   * same-tier fallback model. Steps already reported via onStep belong to the
   * abandoned attempt and should be discarded.
   */
  onRestart?: (info: { fromModelKey: string; toModelKey: string; workerId?: string }) => void;
  /**
   * TASK 9: asks a human to approve one tool call before it runs — every call
   * approval-policy.ts flags: destructive tools, non-read-only SQL, outbound
   * tools (commits, exports, destinations, publishing), credential reads, and
   * every write in assisted mode. Calls routed via call_tool are unwrapped
   * first. Calls that won't execute (dry-run/shadow) aren't gated. On a live
   * run without an approver, flagged calls are denied. The eval path
   * (opts.tools) is never gated.
   */
  /**
   * Called once per tool call after it finishes, is denied, or fails — with
   * the effective tool (call_tool unwrapped), its access level, and why it
   * needed approval if it did. Feeds the audit log (lib/audit-log.ts).
   */
  onToolOutcome?: (outcome: ToolOutcome, workerId?: string) => void;
  approveTool?: (call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    reason: ApprovalReason;
    /** Set when an orchestrated worker made the call (Requirements 11.3, 15.3). */
    workerId?: string;
  }) => Promise<{ approved: boolean; reason?: string }>;
  /**
   * Orchestrator-worker mode (lib/llm/runtime/coordinator.ts). When ORCHESTRATION is
   * `on`, `orchestrate: true` opts this run into the coordinator; when
   * ORCHESTRATION is `always`, `orchestrate: false` opts out. Ignored when
   * ORCHESTRATION is `off`, or when the plan has fewer than two steps that
   * could run at the same time (Requirements 2.2–2.5). Requesting
   * orchestration forces planning as if `planFirst` were set (Requirement 2.6).
   */
  orchestrate?: boolean;
  /** Cap on concurrent workers for this run; the smaller of it and MAX_WORKERS is used (Requirement 3.2). */
  maxWorkers?: number;
  /** Called when a worker starts, so the route can stream a `worker_start` event (Requirement 11.1). */
  onWorkerStart?: (info: { workerId: string; stepId: number; modelKey: string; tools: string[] }) => void;
  /** Called when a worker ends, so the route can stream a `worker_done` event (Requirement 11.2). */
  onWorker?: (worker: WorkerRecord) => void;
}
