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
}

export interface BuildResponse {
  finalText: string;
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  /** Present only if a tool in the run (typically msb_execute_solution) kicked off an async execution. */
  executionId?: string;
  finishReason: string;
}

export interface ModelOption {
  key: string;
  label: string;
  tier: 'cheap' | 'balanced' | 'expensive';
}

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
