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
  /** Present when this tool call failed (after exhausting its RAG-consulting retries, if any). */
  error?: string;
}

export interface AgentStepDTO {
  stepNumber: number;
  text: string;
  toolCalls: AgentToolCallDTO[];
  toolResults: AgentToolResultDTO[];
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
  /** Extra attempts per failed tool call, each preceded by a RAG lookup. Omit for the server default (1). */
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
  /**
   * TASK 10: Token budget for extended thinking (Anthropic/Bedrock only).
   * When set, enables the model's internal reasoning before responding.
   * Minimum 1 000. Good starting point: 8 000–16 000 for complex tasks.
   * Can also be set globally via THINKING_BUDGET_TOKENS env var.
   */
  thinkingBudget?: number;
}

export interface BuildResponse {
  /** Persisted run id — GET /api/runs/:runId to view this later, or replay it from /results. */
  runId: string;
  finalText: string;
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
}

// ── TASK 8: Streaming event types ─────────────────────────────────────────────
// POST /api/build returns a streaming response of newline-delimited JSON events.
// Each line is one BuildStreamEvent. The client accumulates step events and
// replaces the trace on each update; the 'done' event carries the final summary.

export type BuildStreamEvent =
  | { type: 'run_start'; runId: string; toolsConsidered: string[] }
  | { type: 'step'; step: AgentStepDTO }
  | { type: 'done'; finalText: string; finishReason: string; usage: TokenUsage; runId: string }
  | { type: 'error'; error: string; code?: string };

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
  status: 'completed' | 'failed';
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
export type EvalSuite = 'agent' | 'tool_shortlist' | 'rag_judge' | 'judge_calibration';

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
