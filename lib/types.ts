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

export interface BuildRequest {
  description: string;
  /** Model registry key, e.g. "anthropic:sonnet". Omit to use the server default. */
  model?: string;
  /** Must be explicitly true to let the agent reach for the full end-to-end build tool. */
  allowFullBuild?: boolean;
  /** Extra attempts per failed tool call, each preceded by a RAG lookup. Omit for the server default (1). */
  toolRetries?: number;
  /** Tool-call round trips before the loop is forced to stop. Omit for the server default (10). */
  maxSteps?: number;
  /** How many tools the semantic shortlist pulls in, on top of the always-on set. Omit for the server default (12). */
  toolShortlistSize?: number;
}

export interface BuildResponse {
  /** Persisted run id — GET /api/runs/:runId to view this later, or replay it from /results. */
  runId: string;
  finalText: string;
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  /** Present only if a tool in the run (typically msb_execute_solution) kicked off an async execution. */
  executionId?: string;
  finishReason: string;
}

/** POST /api/build's response when it starts a Step Functions run (the default — see ?sync=1 for the old synchronous BuildResponse). */
export interface StartRunResponse {
  runId: string;
  status: 'PENDING';
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
   * 'completed' | 'failed' from the old synchronous path, or one of
   * RunLoopStatus's uppercase values for a Step-Functions-backed run
   * (PENDING/RUNNING/AWAITING_APPROVAL/COMPLETED/FAILED/REJECTED/MAX_STEPS)
   * — both live in the same harness_agent_runs.status column, so this is
   * intentionally loose rather than a shared enum with RunLoopStatus.
   */
  status: string;
  durationMs: number;
  toolsConsidered?: string[];
  executionId?: string;
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
// Step Functions agent-loop run state (lib/execution-store.ts loadRun/
// checkpointStep) — the live, in-progress counterpart to ExecutionRecord
// above, which only ever represents a *finished* run's replay-view shape.
// ============================================================================

export type RunLoopStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'MAX_STEPS';

export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Full live state for one in-progress or finished agent-loop run, as read by the Lambdas and the run-status API route. */
export interface RunState {
  id: string;
  createdAt: string;
  description: string;
  model: string;
  allowFullBuild: boolean;
  status: RunLoopStatus;
  /** AI SDK ModelMessage[] — persisted verbatim so it round-trips into the next generateText() call unchanged. */
  messages: unknown[];
  selectedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  stepCount: number;
  /** Tool-call parts emitted by the last AgentStep, awaiting ExecTools (or an approval decision). */
  pendingToolCalls: PendingToolCall[] | null;
  msbExecutionId: string | null;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** Never returned by any read API — task_token is a bearer credential (see infra README). Server-side use only. */
export interface ApprovalRecord {
  id: string;
  runId: string;
  taskToken: string;
  gatedCalls: PendingToolCall[];
  reasoning: string;
  status: ApprovalStatus;
  feedback?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** ApprovalRecord minus task_token — safe to return from GET /api/approvals. */
export type ApprovalSummary = Omit<ApprovalRecord, 'taskToken'>;

// ============================================================================
// Planner Types (planner_parse_natural_language is still a real MCP tool the
// agent may call — kept for callers that want to work with its output directly)
// ============================================================================

export interface EventDefinition {
  name: string;
  description: string;
  page_types: string[];
  frequency: 'frequent' | 'occasional' | 'rare';
  required_attributes: string[];
  optional_attributes: string[];
}

export interface SegmentDefinition {
  name: string;
  description: string;
  segment_type: string;
  pql_expression: string;
  priority?: number;
  estimated_size?: string;
  destinations: string[];
  merge_policy_id?: string;
}

export interface SolutionConfig {
  website_domain: string;
  business_vertical: string;
  page_types: string[];
  events: EventDefinition[];
  segments: SegmentDefinition[];
  destinations: string[];
  personalization_placements: string[];
  merge_policy: string;
  sandbox_name: string;
  goals: string[];
  success_metrics: string[];
  confidence_score: number;
  extraction_metadata?: Record<string, unknown>;
}

export interface PlannerParseResponse {
  solution_config: SolutionConfig;
  report?: {
    extracted_entities: Record<string, unknown>;
    validation_result: {
      warnings: string[];
      suggestions: string[];
    };
    enrichment_applied: Record<string, unknown>;
  };
}

// ============================================================================
// msb_execute_solution execution tracking
//
// NOTE: msb_get_execution_status's real response shape hasn't been verified
// against a live execution — these fields are the best guess based on the
// tool's stated purpose. Treat unknown fields as `unknown` rather than
// assuming a rigid shape, and tighten this once you've seen a real response.
// ============================================================================

export interface ExecutionStatus {
  execution_id: string;
  status?: string;
  current_phase?: string;
  phase_number?: number;
  total_phases?: number;
  progress?: number;
  logs?: string[];
  error?: string;
  [key: string]: unknown;
}

export interface Artifact {
  type?: string;
  filename?: string;
  content?: string;
  size_bytes?: number;
  generated_at?: string;
  [key: string]: unknown;
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
