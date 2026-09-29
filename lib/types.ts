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
   * set. Omit for the server default. Raise this for requests that need a
   * less obvious tool (e.g. a "list"/lookup tool the request text doesn't
   * closely resemble) — the tradeoff is a larger prompt per tool-call turn.
   */
  toolShortlistSize?: number;
  /**
   * Tool-call round trips before the agent loop is forced to stop. Omit for
   * the server default. Raise this for requests that chain many dependent
   * lookups/writes (e.g. find a property, then its rules, then add a rule
   * component) — if the run ends with finishReason "tool-calls" instead of
   * "stop", it hit this limit mid-task rather than reaching a real answer.
   */
  maxSteps?: number;
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
export type EvalSuite = 'agent' | 'tool_shortlist' | 'rag_judge';

export interface EvalRunSummary {
  id: string;
  suite: EvalSuite;
  /**
   * What was actually graded: a model registry key for the agent/RAG-judge
   * suites, or the retrieval mode ("embeddings:openai", "lexical-fallback")
   * for the tool-shortlist suite.
   */
  subject: string;
  /** Model registry key that graded rubric questions, when any fixture needed one. */
  judgeModel?: string;
  passedCount: number;
  totalCount: number;
  startedAt: string;
  finishedAt: string;
}

export interface EvalResultRecord {
  fixtureId: string;
  passed: boolean;
  /** Why — the mismatch detail, a judge's reasoning, a recall breakdown. */
  notes: string;
  durationMs?: number;
  /** Chat-model tokens spent on this fixture (agent suite only). */
  totalTokens?: number;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalResultRecord[];
}

export interface EvalRunsListResponse {
  evalRuns: EvalRunSummary[];
  total: number;
}
