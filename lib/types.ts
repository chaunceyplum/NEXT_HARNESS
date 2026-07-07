/**
 * TypeScript types for the MCP Harness
 */

// ============================================================================
// Planner Types
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
  extraction_metadata?: Record<string, any>;
}

export interface PlannerParseResponse {
  solution_config: SolutionConfig;
  report?: {
    extracted_entities: Record<string, any>;
    validation_result: {
      warnings: string[];
      suggestions: string[];
    };
    enrichment_applied: Record<string, any>;
  };
}

// ============================================================================
// Execution Types (harness-driven — the harness itself runs the build by
// calling individual AEP / CJA / AJO / RAG tools directly. There is no
// MCP orchestrator tool; msb_execute_solution exists in the MCP but cannot
// be safely invoked via JSON-RPC and is bound by a 30s Lambda timeout that
// a multi-phase build cannot complete within. See lib/plan-builder.ts and
// lib/execution-runner.ts for the real execution model.)
// ============================================================================

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResponse {
  id: string;
  label: string;
  tool: string;
  category: 'rag' | 'aep' | 'launch' | 'cja' | 'ajo';
  critical: boolean;
  status: StepStatus;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ExecutionStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface BuildRequest {
  description: string;
  business_vertical?: string;
  url?: string;
  config_overrides?: Partial<SolutionConfig>;
}

// ============================================================================
// Planning Transparency Types
//
// The build plan is dynamic per use case (lib/plan-builder.ts's capability
// modules + optional LLM refinement in lib/llm-planner.ts) rather than one
// fixed workflow every time. These types surface *why* a given plan looks
// the way it does: which modules were considered, which were included or
// skipped and why, what order they ran in, and whether an LLM reordered
// them or the deterministic heuristic was used (including why the LLM path
// was skipped/fell back, when applicable).
// ============================================================================

export type PlanningMode = 'llm' | 'heuristic';

export interface ModulePlanSummary {
  id: string;
  label: string;
  included: boolean;
  reason: string;
  step_count: number;
}

export interface UseCaseProfile {
  activation_focused: boolean;
  analytics_focused: boolean;
  personalization_focused: boolean;
  needs_data_collection: boolean;
  summary: string;
}

export interface PlanningInfo {
  planning_mode: PlanningMode;
  use_case: UseCaseProfile;
  modules: ModulePlanSummary[];
  module_order: string[];
  llm_reasoning?: string;
  llm_fallback_reason?: string;
}

export interface BuildResponse {
  execution_id: string;
  status: ExecutionStatus;
  message: string;
  step_count: number;
  planning: PlanningInfo;
}

export interface StatusResponse {
  execution_id: string;
  status: ExecutionStatus;
  progress: number; // 0.0 to 1.0
  current_step: string | null;
  steps: StepResponse[];
  error?: string;
  planning?: PlanningInfo;
  /** Lightweight observability rollup so the status view can show live counts. */
  observability?: ObservabilitySummary;
}

// ============================================================================
// Observability Types
//
// Everything the build function does is traced (lib/observability.ts):
// an ordered timeline of events, plus one structured record per real MCP
// tool call (with timing, arg/output previews, and errors). These types
// shape that data for the API (GET /api/executions/:id/trace) and the UI.
// ============================================================================

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceEventResponse {
  seq: number;
  timestamp: string;
  level: TraceLevel;
  type: string;
  message: string;
  step_id?: string;
  tool?: string;
  category?: string;
  duration_ms?: number;
  data?: Record<string, any>;
}

export interface ToolInvocationResponse {
  seq: number;
  step_id: string;
  tool: string;
  category: string;
  status: 'success' | 'error';
  args_preview: string;
  output_preview?: string;
  output_bytes?: number;
  error?: string;
  duration_ms: number;
  started_at: string;
  completed_at: string;
}

export interface ObservabilityMetrics {
  total_events: number;
  total_invocations: number;
  invocations_by_status: Record<string, number>;
  invocations_by_tool: Record<string, number>;
  invocations_by_category: Record<string, number>;
  total_tool_duration_ms: number;
  avg_tool_duration_ms: number;
  slowest_invocation?: {
    tool: string;
    step_id: string;
    duration_ms: number;
  };
  wall_clock_ms: number;
}

/** Compact rollup embedded in the status response for the live UI. */
export interface ObservabilitySummary {
  total_events: number;
  total_invocations: number;
  invocations_by_status: Record<string, number>;
  total_tool_duration_ms: number;
}

export interface TraceResponse {
  execution_id: string;
  status: ExecutionStatus;
  metrics: ObservabilityMetrics;
  events: TraceEventResponse[];
  invocations: ToolInvocationResponse[];
}

export interface ExecutionSummary {
  execution_id: string;
  description: string;
  status: ExecutionStatus;
  progress: number;
  website_domain?: string;
  business_vertical?: string;
  step_count: number;
  completed_step_count: number;
  failed_step_count: number;
  planning_mode?: PlanningMode;
  /** Total real MCP tool calls made during this build (observability). */
  invocation_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ListExecutionsResponse {
  executions: ExecutionSummary[];
  total: number;
}

// ============================================================================
// API Error Types
// ============================================================================

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, any>;
}

export class MCPError extends Error {
  constructor(
    message: string,
    public code: string = 'MCP_ERROR',
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public details?: Record<string, any>) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// UI State Types
// ============================================================================

export interface ExecutionState {
  id: string;
  description: string;
  status: 'idle' | 'loading' | ExecutionStatus;
  progress: number;
  currentStep: string | null;
  steps: StepResponse[];
  error?: string;
}
