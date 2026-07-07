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

export interface BuildResponse {
  execution_id: string;
  status: ExecutionStatus;
  message: string;
  step_count: number;
}

export interface StatusResponse {
  execution_id: string;
  status: ExecutionStatus;
  progress: number; // 0.0 to 1.0
  current_step: string | null;
  steps: StepResponse[];
  error?: string;
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
