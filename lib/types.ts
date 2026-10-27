/**
 * TypeScript types for the MCP Harness
 */

// ============================================================================
// Agent Types (dynamic orchestration — see lib/llm/agent.ts)
// ============================================================================

export interface AgentToolCallDTO {
  toolName: string;
  input: unknown;
}

export interface AgentToolResultDTO {
  toolName: string;
  output: unknown;
  /** Present when this tool call failed (after exhausting its transient-error retries, if any). */
  error?: string;
  /** Wall-clock time this tool call took, in ms. Absent on runs persisted before per-step timing was tracked. */
  durationMs?: number;
}

export interface AgentStepDTO {
  stepNumber: number;
  text: string;
  toolCalls: AgentToolCallDTO[];
  toolResults: AgentToolResultDTO[];
  /** Wall-clock time for the whole step (model + tools), in ms. Absent on runs from before per-step metrics were tracked. */
  durationMs?: number;
  /** Time spent waiting on the model response, in ms. */
  modelMs?: number;
  /** Chat-model tokens for this step alone. */
  usage?: TokenUsage;
  /**
   * Orchestrator-worker mode (lib/llm/coordinator.ts): the id of the worker
   * that produced this step, when the run was orchestrated. Absent on
   * single-agent runs, so their step shape is unchanged (Requirement 11.3).
   */
  workerId?: string;
}

// ============================================================================
// Orchestrator-worker types (lib/llm/coordinator.ts, lib/llm/worker.ts)
// ============================================================================

/**
 * Lifecycle of one worker (one plan step carried out by its own bounded agent
 * loop). `done` / `failed` mirror the report_result status; `cancelled` is a
 * worker aborted by the run's kill switch / cancel (Requirement 9.4).
 */
export type WorkerStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The structured result a worker hands back with the report_result tool
 * (Requirement 5.1). `summary` is capped at 1,000 and `notes` at 500 chars by
 * the tool before it reaches here (Requirement 5.2).
 */
export interface WorkerResult {
  stepId: number;
  status: 'done' | 'failed';
  /** ≤ 1,000 chars. */
  summary: string;
  /** Ids a dependent step needs, e.g. { dataElementId: 'DE123' }. */
  ids: Record<string, string>;
  /** ≤ 500 chars. */
  notes?: string;
}

/**
 * One worker attempt, stored inside the run record's `result` JSONB
 * (Requirement 12.1) and emitted on the `worker_done` stream event
 * (Requirement 11.2). `workerId` is `${runId}:w${stepId}:${attempt}`.
 */
export interface WorkerRecord {
  workerId: string;
  stepId: number;
  attempt: number;
  modelKey: string;
  status: WorkerStatus;
  steps: AgentStepDTO[];
  result?: WorkerResult;
  budgetUsage: { tokens: number; costUsd?: number; durationMs: number };
  startedAt: string;
  durationMs?: number;
  error?: string;
}

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

/**
 * Chat-model token usage for one run, summed across every step of the
 * agent loop. Does NOT include the tool-shortlisting embedding call or any
 * RAG-judge calls (lib/llm/rag-judge.ts) — both are real but comparatively
 * small costs; this covers the dominant one (the actual chat model)
 * without threading usage through every side call. Any field can be
 * `undefined` if the provider didn't report it.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface BuildRequest {
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
  /** Plan before acting (lib/llm/planner.ts). Defaults to PLAN_FIRST. */
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
   * entry is a key from PLATFORM_GROUPS (lib/llm/tool-catalog.ts). Omit or
   * leave empty to include all platforms.
   */
  platformFilter?: string[];
  /**
   * Launch-tagging run: ground the agent on the Adobe Launch/Reactor object
   * model (injected into the cached system prompt — see lib/llm/agent-core.ts).
   * Omit to infer it from platformFilter targeting the Launch/Reactor group;
   * set false to keep the lean prompt even then. The deliverable stops at a
   * populated library unless publishTarget is set (see below).
   */
  launchMode?: boolean;
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
   * Orchestrator-worker mode (lib/llm/coordinator.ts). Opts this run into the
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

/**
 * One knowledge-search quality judgment collected during a run by the
 * fire-and-forget RAG judge (lib/llm/rag-judge.ts), persisted with the run
 * record for monitoring. Structural type — see RagJudgmentEntry /
 * RagJudgment in the llm layer for the source shape — kept here so this
 * module doesn't take a hard dependency on the llm layer, matching how
 * EvalRunSummary references eval-metrics via an inline import type.
 */
export interface RagJudgmentDTO {
  toolName: string;
  query: string;
  judgment: import('./llm/rag-judge').RagJudgment;
}

export interface BuildResponse {
  /** Persisted run id — GET /api/runs/:runId to view this later, or replay it from /results. */
  runId: string;
  finalText: string;
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
  /** Set when a run budget or loop detection cut the run short (lib/llm/run-budget.ts). */
  stopReason?: string;
  /** Tokens, estimated cost (when the model is priced), and wall-clock time the run used. */
  budgetUsage?: { tokens: number; costUsd?: number; durationMs: number };
  /** Present on a record saved mid-run (status 'running' or 'interrupted'). */
  checkpoint?: { schemaVersion: number; step: number; savedAt: string };
  /** The plan as executed, when the run planned first. */
  plan?: PlanInfo;
  /** Grounding check on the final answer, when it ran. */
  critique?: CritiqueInfo;
  /** Set when the run asked for model "auto". */
  route?: RouteInfo;
  /**
   * Quality judgments for a sample of the run's knowledge searches, scored
   * off the critical path by the RAG judge. Absent on runs from before this
   * was tracked, and empty when nothing was sampled or judging was disabled.
   */
  ragJudgments?: RagJudgmentDTO[];
  /** Version fingerprints (prompt/toolset/app). Absent on runs from before versioning. */
  versions?: RunVersions;
  /**
   * Orchestrator-worker fields (lib/llm/coordinator.ts), stored inside the
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

// ── TASK 8: Streaming event types ─────────────────────────────────────────────
// POST /api/build returns a streaming response of newline-delimited JSON events.
// Each line is one BuildStreamEvent. The client accumulates step events and
// replaces the trace on each update; 'restart' means a fallback model is
// re-running from scratch, so discard steps so far; 'approval_request' means
// the run is paused until POST /api/build/approve; 'done' carries the final summary.

export type BuildStreamEvent =
  | { type: 'run_start'; runId: string; toolsConsidered: string[] }
  // `workerId` is set when the step came from an orchestrated worker, so the
  // client can file it under that worker's lane (Requirement 11.3); absent on
  // single-agent runs, keeping their event shape unchanged (Requirement 11.5).
  | { type: 'step'; step: AgentStepDTO; workerId?: string }
  // TASK 1 (token streaming): a chunk of assistant text as it's generated.
  // The client appends these for a live view; the authoritative final text
  // still arrives on 'done'. Discard accumulated deltas on 'restart'.
  | { type: 'text_delta'; delta: string }
  // `workerId` present: only that worker's steps are discarded, not the whole
  // run's (Requirement 11.3, 11.4). Absent: a single-agent same-tier restart.
  | { type: 'restart'; fromModelKey: string; toModelKey: string; workerId?: string }
  /** The answer has finished streaming and is being checked against the tool results (answer-critic.ts); 'done' carries the checked, possibly revised, text. */
  | { type: 'checking' }
  /** The run's plan: sent when made (awaitingApproval while a person decides) and on every status change or revision. */
  | { type: 'plan'; plan: PlanInfo; awaitingApproval?: boolean }
  /** The request asked for model "auto": which model it was routed to, and why. */
  | { type: 'route'; route: RouteInfo }
  // ── Orchestrator-worker events (Requirements 11.1, 11.2) ──────────────────
  /** A worker started: the client opens a lane for it. */
  | { type: 'worker_start'; workerId: string; stepId: number; modelKey: string; tools: string[] }
  /** A worker ended: its final status, result (if any) and token spend. */
  | {
      type: 'worker_done';
      workerId: string;
      stepId: number;
      status: WorkerStatus;
      result?: WorkerResult;
      budgetUsage: { tokens: number; costUsd?: number; durationMs: number };
      error?: string;
    }
  | {
      type: 'approval_request';
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Why this call needs a person (lib/llm/approval-policy.ts), e.g. 'outbound'. */
      reason: string;
      /** Human-readable form of `reason`. */
      reasonText: string;
      /** Set when the call came from an orchestrated worker (Requirement 11.3). */
      workerId?: string;
    }
  | { type: 'approval_resolved'; toolCallId: string; approved: boolean; reason: string }
  | {
      type: 'done';
      finalText: string;
      finishReason: string;
      usage: TokenUsage;
      runId: string;
      /** Model that produced the result — differs from the requested one after a fallback. */
      modelKey: string;
      toolsConsidered: string[];
      stopReason?: string;
      budgetUsage?: { tokens: number; costUsd?: number; durationMs: number };
      /** Version fingerprints (prompt/toolset/app) for this run. */
      versions?: RunVersions;
      critique?: CritiqueInfo;
    }
  | { type: 'error'; error: string; code?: string };

/** Mirrors lib/llm/planner.ts Plan, for client code. */
export interface PlanInfo {
  goal: string;
  version: number;
  steps: Array<{
    id: number;
    description: string;
    tool: string | null;
    expectedOutput: string;
    dependsOn: number[];
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    note?: string;
    /** The worker running this step, when the run is orchestrated (Requirement 15.2). */
    workerId?: string;
  }>;
}

/** Grounding check on the final answer (lib/llm/answer-critic.ts). */
export interface CritiqueInfo {
  passed: boolean;
  grounded: boolean;
  answersRequest: boolean;
  unsupportedClaims: string[];
  issues: string[];
  revised: boolean;
  originalAnswer?: string;
  model: string;
  /** The critic was the same model that wrote the answer. */
  selfCheck?: boolean;
}

/** Mirrors lib/llm/model-router.ts RouteDecision (kept here so client code needn't import server modules). */
export interface RouteInfo {
  category: 'lookup' | 'change' | 'build' | 'unclear';
  confidence: number;
  reason: string;
  via: 'rules' | 'model' | 'fallback';
  modelKey: string;
  tier?: 'cheap' | 'balanced' | 'expensive';
  clarifyingQuestion?: string;
}

export interface ModelOption {
  key: string;
  label: string;
  tier: 'cheap' | 'balanced' | 'expensive';
}

// ============================================================================
// Execution history / replay (lib/execution-store.ts)
// ============================================================================

export interface RunSummary {
  id: string;
  createdAt: string;
  description: string;
  model: string;
  allowFullBuild: boolean;
  /**
   * running: in progress (checkpointed after every step). interrupted: the
   * server stopped while it was running (marked on the next start); it can
   * be resumed from /results/[id].
   */
  status: 'completed' | 'failed' | 'running' | 'interrupted';
  durationMs: number;
  toolsConsidered?: string[];
  executionId?: string;
  /** Absent on runs persisted before token tracking was added, and on failed runs (the agent never got a usage figure). */
  usage?: TokenUsage;
}

export interface ExecutionRecord extends RunSummary {
  request: BuildRequest;
  result?: BuildResponse;
  error?: string;
}

export interface RunsListResponse {
  runs: RunSummary[];
  total: number;
}

// ============================================================================
// API Error Types
// ============================================================================

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

export class MCPError extends Error {
  constructor(
    message: string,
    public code: string = 'MCP_ERROR',
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// Eval history (lib/eval-store.ts, written by evals/lib/report.ts)
// ============================================================================

/** Which eval suite a run came from — one per `npm run eval:*` file. */
export type EvalSuite = 'agent' | 'launch' | 'tool_shortlist' | 'rag_judge' | 'judge_calibration' | 'critic_calibration' | 'routing';

export interface EvalRunSummary {
  id: string;
  suite: EvalSuite;
  /**
   * What was actually graded: a model registry key for the agent/RAG-judge/
   * judge-calibration suites, or the retrieval mode ("embeddings:openai",
   * "lexical-fallback") for the tool-shortlist suite.
   */
  subject: string;
  /** Model registry key that graded rubric questions, when any fixture needed one. */
  judgeModel?: string;
  /** Short hash of the agent system prompt that was graded, so a score can be tied to a prompt change. */
  promptVersion?: string;
  /** Passed trials / all trials (with k trials per fixture, total = fixtures × k). */
  passedCount: number;
  totalCount: number;
  /** Trials per fixture (EVAL_TRIALS). */
  trialsPerFixture: number;
  /** Computed by lib/eval-metrics.ts at save time. Absent on runs saved before metrics existed. */
  metrics?: import('./eval-metrics').EvalRunMetrics;
  startedAt: string;
  finishedAt: string;
}

/** One trial of one fixture. */
export interface EvalTrialRecord {
  fixtureId: string;
  /** 1-based trial number within the run. */
  trial: number;
  passed: boolean;
  /**
   * The grader or the infrastructure failed, not the thing being graded: the
   * judge refused and so did its fallback, a provider call threw mid-run. An
   * errored trial is always `passed: false`, but it is excluded from every
   * rate so a flaky judge can't masquerade as a bad agent.
   */
  errored?: boolean;
  /** Why — the mismatch detail, a judge's per-criterion scores, a recall breakdown. */
  notes: string;
  /** Fixture category, e.g. "safety". */
  category?: string;
  /** Whether the deterministic checks (tools, args, order, limits) passed, independent of the judge. */
  structuralPassed?: boolean;
  /** The agent made a call a fixture marks unsafe (e.g. followed an injected instruction). */
  safetyViolation?: boolean;
  durationMs?: number;
  /** Chat-model tokens spent on this trial (agent suite only). */
  totalTokens?: number;
  /** Estimated USD at list price (lib/llm/pricing.ts); absent if the model has no known price. */
  costUsd?: number;
  /** Agent loop steps taken. */
  steps?: number;
  /** Tool calls made. */
  toolCalls?: number;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalTrialRecord[];
}

export interface EvalRunsListResponse {
  evalRuns: EvalRunSummary[];
  total: number;
}
