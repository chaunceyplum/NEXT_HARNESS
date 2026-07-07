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
// Orchestrator Types
// ============================================================================

export interface OrchestratorExecuteResponse {
  execution_id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  phase: string;
  estimated_duration_seconds: number;
  message: string;
}

export interface OrchestratorStatusResponse {
  execution_id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  current_phase: string;
  phase_number: number;
  total_phases: number;
  progress: number; // 0.0 to 1.0
  estimated_time_remaining_seconds: number;
  logs: string[];
  error?: string;
  artifacts?: string[];
}

export interface Artifact {
  type: 'sql' | 'json' | 'javascript' | 'terraform' | 'text' | 'yaml';
  filename: string;
  content: string;
  size_bytes: number;
  generated_at: string;
}

export interface OrchestratorArtifactsResponse {
  artifacts: Artifact[];
  summary: {
    total_artifacts: number;
    total_size_bytes: number;
  };
}

// ============================================================================
// Execution Types
// ============================================================================

export interface Execution {
  id: string;
  user_id?: string;
  description: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  phase?: string;
  progress: number;
  solution_config?: SolutionConfig;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
}

export interface BuildRequest {
  description: string;
  business_vertical?: string;
  url?: string;
  config_overrides?: Partial<SolutionConfig>;
}

export interface BuildResponse {
  execution_id: string;
  status: string;
  message: string;
}

export interface StatusResponse {
  execution_id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  current_phase: string;
  phase_number: number;
  total_phases: number;
  progress: number;
  logs: string[];
  error?: string;
}

export interface ArtifactsResponse {
  artifacts: Artifact[];
  total_artifacts: number;
  total_size_bytes: number;
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
  status: 'idle' | 'loading' | 'running' | 'completed' | 'error';
  progress: number;
  currentPhase: string;
  logs: string[];
  error?: string;
  artifacts?: Artifact[];
}
