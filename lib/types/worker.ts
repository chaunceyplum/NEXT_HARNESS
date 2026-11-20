/** Orchestrator-worker records (lib/llm/runtime/coordinator.ts, worker.ts). */

import type { StepRecord } from './agent';
import type { ChangedObject } from './adobe';

/**
 * Lifecycle of one worker (one plan step carried out by its own bounded agent
 * loop). `done` / `failed` mirror the report_result status; `cancelled` is a
 * worker aborted by the run's kill switch / cancel (Requirement 9.4).
 */
export type WorkerStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The structured result a worker hands back with the report_result tool
 * (Requirement 5.1). `summary` is capped at 2,000 and `notes` at 500 chars by
 * the tool before it reaches here (Requirement 5.2; the summary cap was 1,000).
 */
export interface WorkerResult {
  stepId: number;
  status: 'done' | 'failed';
  /** ≤ 2,000 chars. */
  summary: string;
  /** Ids a dependent step needs, e.g. { dataElementId: 'DE123' }. */
  ids: Record<string, string>;
  /** ≤ 500 chars. */
  notes?: string;
  /**
   * The Adobe objects this worker actually changed, derived from its executed
   * tool calls (lib/llm/tools/object-refs.ts) rather than claimed by the
   * model. Dependent steps see them as typed references. Absent when it
   * changed nothing.
   */
  objects?: ChangedObject[];
  /**
   * Objects this worker's tool results showed it (ids from reads, not
   * changes), from its own steps (object-ledger.ts extractObjects), capped.
   * Before this, a dependent step got only the ids the model chose to put in
   * report_result, and an id it read but didn't report was lost. Absent when
   * it saw none.
   */
  seen?: SeenObject[];
}

/** An object a worker's tool results showed it. */
export interface SeenObject {
  id: string;
  label?: string;
  kind?: string;
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
  steps: StepRecord[];
  result?: WorkerResult;
  budgetUsage: { tokens: number; costUsd?: number; durationMs: number };
  startedAt: string;
  durationMs?: number;
  error?: string;
}
