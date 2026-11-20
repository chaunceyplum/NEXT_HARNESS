/** One agent loop step: the tool calls it made, their results, timing and token usage. */

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
}

export interface ToolResultRecord {
  toolName: string;
  output: unknown;
  /** Present when this tool call failed (after exhausting its transient-error retries, if any). */
  error?: string;
  /** Wall-clock time this tool call took, in ms. Absent on runs persisted before per-step timing was tracked. */
  durationMs?: number;
}

export interface StepRecord {
  stepNumber: number;
  text: string;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  /** Wall-clock time for the whole step (model + tools), in ms. Absent on runs from before per-step metrics were tracked. */
  durationMs?: number;
  /** Time spent waiting on the model response, in ms. */
  modelMs?: number;
  /** Chat-model tokens for this step alone. */
  usage?: TokenUsage;
  /**
   * Orchestrator-worker mode (lib/llm/runtime/coordinator.ts): the id of the worker
   * that produced this step, when the run was orchestrated. Absent on
   * single-agent runs, so their step shape is unchanged (Requirement 11.3).
   */
  workerId?: string;
}

/**
 * Chat-model token usage for one run, summed across every step of the
 * agent loop. Does NOT include the tool-shortlisting embedding call or any
 * RAG-judge calls (lib/llm/quality/rag-judge.ts) — both are real but comparatively
 * small costs; this covers the dominant one (the actual chat model)
 * without threading usage through every side call. Any field can be
 * `undefined` if the provider didn't report it.
 */
export interface TokenUsage {
  /** Every input token, cached or not. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** The part of inputTokens read from the prompt cache (billed at a fraction of the input price). */
  cacheReadTokens?: number;
  /** The part of inputTokens written to the prompt cache (billed above the input price). */
  cacheWriteTokens?: number;
}
