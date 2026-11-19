/** A run: its request, its result, and its stored record (lib/run-store.ts). */

import type { RunStatus } from '../run-lifecycle';
import type { StepRecord, TokenUsage } from './agent';
import type { WorkerResult, WorkerRecord } from './worker';
import type { PlanRecord } from './plan';
import type { RagJudgmentRecord, CritiqueRecord } from './quality';
import type { RouteRecord } from './model';

/**
 * Version fingerprints for a run (lib/version.ts) — short sha256 hashes that
 * tie a stored run to the exact prompt, tool set and build it came from.
 * Absent on runs persisted before versioning was tracked.
 */
export interface RunVersions {
  prompt: string;
  toolset: string;
  app: string;
}

export interface RunRequest {
  description: string;
  /** Model registry key, e.g. "anthropic:sonnet". Omit to use the server default. */
  model?: string;
  /** Extra attempts after a transient (5xx/timeout/429) tool failure. Omit for the server default (1). */
  toolRetries?: number;
  /**
   * How many tools the semantic shortlist pulls in, on top of the always-on
   * set. Omit for the server default.
   */
  toolShortlistSize?: number;
  /**
   * Tool-call round trips before the agent loop is forced to stop. Omit for
   * the server default.
   */
  maxSteps?: number;
  /**
   * Server-set when this run resumes an interrupted one: what the earlier
   * attempt already did, appended to the request. Never read from the body.
   */
  resumeContext?: string;
  /** Server-set: the interrupted run this one resumes. */
  resumedFrom?: string;
  /**
   * Server-set when the interrupted run was orchestrated (Requirement 12.4):
   * its plan with the done steps kept and every other step reset to pending,
   * plus the WorkerResults of the done steps. The resumed run executes this
   * plan instead of making a new one, so only the unfinished steps run.
   * Never read from the body.
   */
  resumePlan?: ResumePlan;
  /** Set by the server from the authenticated user; ignored if sent in the body. */
  requestedBy?: string;
  /** Token budget for this run. Can only tighten RUN_MAX_TOKENS. */
  maxTokens?: number;
  /** Estimated-cost ceiling (USD) for this run. Can only tighten RUN_MAX_COST_USD. */
  maxCostUsd?: number;
  /**
   * TASK 9: Tool policy. 'read-only' removes all write and destructive tools
   * so the model structurally cannot call them. Can only tighten the
   * BUILD_POLICY env var — 'full' does not override BUILD_POLICY=read-only.
   */
  policy?: 'full' | 'read-only';
  /**
   * TASK 9: When true, destructive tools describe what they would do instead
   * of executing. Can only tighten the TOOL_DRY_RUN env var — false does not
   * override TOOL_DRY_RUN=true.
   */
  dryRun?: boolean;
  /** Plan before acting (lib/llm/runtime/planner.ts). Defaults to PLAN_FIRST. */
  planFirst?: boolean;
  /** Pause for a person to approve the plan before anything runs. PLAN_APPROVAL=true forces it on. */
  requirePlanApproval?: boolean;
  /**
   * Rollout stage: 'assisted' asks before every write, 'shadow' dry-runs
   * every write. Can only tighten the ROLLOUT_MODE env var.
   */
  rolloutMode?: 'autonomous' | 'assisted' | 'shadow';
  /**
   * TASK 10: Extended thinking (Claude via Anthropic/Bedrock only), 1 024–64 000.
   * On Haiku 4.5 and older it's the thinking token budget (8 000–16 000 is a
   * good start); newer models only take adaptive thinking, so there any value
   * just switches it on. Can also be set globally via THINKING_BUDGET_TOKENS.
   */
  thinkingBudget?: number;
  /**
   * Restrict the tool catalog to tools belonging to these platforms only. Each
   * entry is a key from PLATFORM_GROUPS (lib/llm/tools/tool-catalog.ts). Omit or
   * leave empty to include all platforms.
   */
  platformFilter?: string[];
  /**
   * Launch-tagging run: ground the agent on the Adobe Launch/Reactor object
   * model (injected into the cached system prompt — see lib/llm/runtime/agent-core.ts).
   * Omit to infer it from platformFilter targeting the Launch/Reactor group;
   * set false to keep the lean prompt even then. The deliverable stops at a
   * populated library unless publishTarget is set (see below).
   */
  launchMode?: boolean;
  /**
   * Segment/audience run: ground the agent on the PQL reference, the business
   * glossary and the real-fields-only rules, and keep the field lookup and
   * segment tools always on (lib/llm/domains/segments). Omit to infer it from
   * a request that mentions segments, audiences or PQL; set false to keep the
   * lean prompt even then.
   */
  segmentMode?: boolean;
  /**
   * Publish target for a Launch run. ABSENT → library-only, byte-identical to
   * today's behaviour (the run stops at a populated library and never
   * publishes). PRESENT → the run MAY publish the populated library, subject
   * to the dev/staging rule: publishing is permitted ONLY to a development or
   * staging environment (resolved from server truth), and a production — or an
   * unresolvable — stage is refused in code before the transition is sent.
   *
   * The stage decision is driven by `environmentId` / `environmentName`
   * resolved against the environment facts the run reads (reactor_get_environment
   * / reactor_list_environments); `propertyId` is accepted for completeness
   * but does not drive the stage decision.
   */
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string };
  /**
   * Orchestrator-worker mode (lib/llm/runtime/coordinator.ts). Opts this run into the
   * coordinator when ORCHESTRATION=on; opts out when ORCHESTRATION=always.
   * Ignored when ORCHESTRATION=off (Requirements 2.2–2.4).
   */
  orchestrate?: boolean;
  /**
   * Cap on concurrent workers for this run; the smaller of it and MAX_WORKERS
   * is used (Requirement 3.2).
   */
  maxWorkers?: number;
}

export interface RunResult {
  /** Persisted run id — GET /api/runs/:runId to view this later, or replay it from /results. */
  runId: string;
  finalText: string;
  steps: StepRecord[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
  /** Set when a run budget or loop detection cut the run short (lib/llm/runtime/run-budget.ts). */
  stopReason?: string;
  /** Tokens, estimated cost (when the model is priced), and wall-clock time the run used. */
  budgetUsage?: { tokens: number; costUsd?: number; durationMs: number };
  /** Present on a record saved mid-run (status 'running' or 'interrupted'). */
  checkpoint?: { schemaVersion: number; step: number; savedAt: string };
  /** The plan as executed, when the run planned first. */
  plan?: PlanRecord;
  /** Grounding check on the final answer, when it ran. */
  critique?: CritiqueRecord;
  /** Set when the run asked for model "auto". */
  route?: RouteRecord;
  /**
   * Quality judgments for a sample of the run's knowledge searches, scored
   * off the critical path by the RAG judge. Absent on runs from before this
   * was tracked, and empty when nothing was sampled or judging was disabled.
   */
  ragJudgments?: RagJudgmentRecord[];
  /** Version fingerprints (prompt/toolset/app). Absent on runs from before versioning. */
  versions?: RunVersions;
  /**
   * Orchestrator-worker fields (lib/llm/runtime/coordinator.ts), stored inside the
   * existing `result` JSONB — no table schema change (Requirement 12.1).
   * `orchestrated` is true when the coordinator ran the plan as concurrent
   * workers; `workers` are those workers' records and `replans` counts the
   * replanning calls made. Absent / false on single-agent runs, so their
   * stored shape is unchanged.
   */
  orchestrated?: boolean;
  replans?: number;
  workers?: WorkerRecord[];
}

/** Mirrors lib/llm/runtime/planner.ts Plan, for client code. */
/** A stored orchestrated plan to continue (RunRequest.resumePlan). */
export interface ResumePlan {
  plan: PlanRecord;
  results: WorkerResult[];
}

export interface RunSummary {
  id: string;
  createdAt: string;
  description: string;
  model: string;
  /**
   * The lifecycle status (lib/run-lifecycle.ts). running: in progress
   * (checkpointed after every step). awaiting_approval: paused on a person.
   * cancelled: stopped by a person or the kill switch. interrupted: the
   * server stopped mid-run (marked on the next start). failed, cancelled and
   * interrupted runs can be resumed from /results/[id].
   */
  status: RunStatus;
  durationMs: number;
  toolsConsidered?: string[];
  /** Absent on runs persisted before token tracking was added, and on failed runs (the agent never got a usage figure). */
  usage?: TokenUsage;
}

export interface RunRecord extends RunSummary {
  request: RunRequest;
  result?: RunResult;
  error?: string;
}

export interface RunsListResponse {
  runs: RunSummary[];
  total: number;
}
