/** The NDJSON event stream of a run (POST /api/build, GET /api/runs/:id/events). */

import type { StepRecord, TokenUsage } from './agent';
import type { WorkerStatus, WorkerResult } from './worker';
import type { PlanRecord } from './plan';
import type { CritiqueRecord } from './quality';
import type { RouteRecord } from './model';
import type { RunVersions } from './run';

// ── TASK 8: Streaming event types ─────────────────────────────────────────────
// POST /api/build returns a streaming response of newline-delimited JSON events.
// Each line is one RunStreamEvent. The client accumulates step events and
// replaces the trace on each update; 'restart' means a fallback model is
// re-running from scratch, so discard steps so far; 'approval_request' means
// the run is paused until POST /api/build/approve; 'done' carries the final summary.

export type RunStreamEvent =
  | { type: 'run_start'; runId: string; toolsConsidered: string[] }
  // `workerId` is set when the step came from an orchestrated worker, so the
  // client can file it under that worker's lane (Requirement 11.3); absent on
  // single-agent runs, keeping their event shape unchanged (Requirement 11.5).
  | { type: 'step'; step: StepRecord; workerId?: string }
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
  | { type: 'plan'; plan: PlanRecord; awaitingApproval?: boolean }
  /** The request asked for model "auto": which model it was routed to, and why. */
  | { type: 'route'; route: RouteRecord }
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
      /** Why this call needs a person (lib/llm/tools/approval-policy.ts), e.g. 'outbound'. */
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
      critique?: CritiqueRecord;
    }
  | { type: 'error'; error: string; code?: string };
