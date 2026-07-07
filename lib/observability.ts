/**
 * Observability
 *
 * End-to-end tracing for everything the build function does. The harness
 * itself runs the build (there is no MCP orchestrator — see
 * lib/execution-runner.ts), so this layer instruments that runner: every
 * lifecycle transition, every planned step, and — most importantly — every
 * individual MCP tool call (`callMcpTool`) is captured as:
 *
 *   1. A structured TRACE EVENT — an ordered, timestamped log line
 *      (planning decision, step started/succeeded/failed/skipped, tool
 *      invoked, ref-resolution failure, execution finished, ...). This is
 *      the human-readable timeline.
 *
 *   2. A TOOL INVOCATION RECORD — one row per real MCP tool call, with the
 *      tool name, the (summarized/size-capped) arguments and output, the
 *      status, the duration in milliseconds, and any error. This is the
 *      structured audit trail / metrics source, analogous to the MCP's own
 *      `tool_invocations` table but living in the harness.
 *
 * Every emit also writes a structured line to the server console (so it
 * shows up in `next start` / container logs / CloudWatch), AND appends to
 * the in-process execution record (so it's queryable via the API and
 * visible in the UI). Recording is best-effort and never throws into the
 * build path — an observability failure must never break a build.
 *
 * DEPLOYMENT CAVEAT: like the rest of the execution store, the recorded
 * trace/invocations are process-local and in-memory. Console output is the
 * durable sink; the in-memory copy powers the live UI. See
 * lib/execution-store.ts for the multi-instance caveat.
 */

import {
  appendTraceEvent,
  appendInvocation,
  ExecutionRecord,
} from './execution-store';

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export type TraceEventType =
  | 'execution.created'
  | 'execution.started'
  | 'execution.finished'
  | 'planning.decided'
  | 'step.started'
  | 'step.ref_resolution_failed'
  | 'step.tool_invoked'
  | 'step.succeeded'
  | 'step.failed'
  | 'step.skipped';

export interface TraceEvent {
  /** Monotonic sequence number within the execution (0-based). */
  seq: number;
  timestamp: string;
  level: TraceLevel;
  type: TraceEventType;
  message: string;
  stepId?: string;
  tool?: string;
  category?: string;
  durationMs?: number;
  /** Small structured payload (already summarized/size-capped). */
  data?: Record<string, any>;
}

export type InvocationStatus = 'success' | 'error';

export interface ToolInvocationRecord {
  seq: number;
  stepId: string;
  tool: string;
  category: string;
  status: InvocationStatus;
  /** Size-capped JSON preview of the resolved arguments actually sent. */
  argsPreview: string;
  /** Size-capped JSON preview of the tool output (success only). */
  outputPreview?: string;
  /** Approximate serialized byte size of the raw output. */
  outputBytes?: number;
  error?: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

// ── Summarization helpers ────────────────────────────────────────────────
// Tool args/outputs can be large (schemas, definitions, arrays). We store a
// size-capped preview for observability rather than the full payload twice
// (the full result already lives on the step record).

const PREVIEW_MAX_CHARS = 2000;

export function summarizeValue(value: unknown): { preview: string; bytes: number } {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized === undefined) serialized = 'undefined';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const preview =
    serialized.length > PREVIEW_MAX_CHARS
      ? serialized.slice(0, PREVIEW_MAX_CHARS) + `… [truncated, ${serialized.length} chars total]`
      : serialized;
  return { preview, bytes };
}

// ── Tracer ───────────────────────────────────────────────────────────────
// A per-execution tracer that assigns sequence numbers, writes structured
// console logs, and appends to the execution record. All methods are
// best-effort: any internal failure is swallowed so tracing can never break
// a build.

export class ExecutionTracer {
  private seq = 0;
  private invocationSeq = 0;

  constructor(private readonly executionId: string) {}

  /** Emit a structured trace event. */
  event(
    type: TraceEventType,
    message: string,
    opts: {
      level?: TraceLevel;
      stepId?: string;
      tool?: string;
      category?: string;
      durationMs?: number;
      data?: Record<string, any>;
    } = {}
  ): void {
    try {
      const evt: TraceEvent = {
        seq: this.seq++,
        timestamp: new Date().toISOString(),
        level: opts.level ?? 'info',
        type,
        message,
        stepId: opts.stepId,
        tool: opts.tool,
        category: opts.category,
        durationMs: opts.durationMs,
        data: opts.data,
      };

      // Structured console line for durable server-side logs.
      const logLine = JSON.stringify({
        scope: 'build.trace',
        executionId: this.executionId,
        ...evt,
      });
      if (evt.level === 'error') console.error(logLine);
      else if (evt.level === 'warn') console.warn(logLine);
      else console.log(logLine);

      appendTraceEvent(this.executionId, evt);
    } catch {
      // Never let tracing break the build.
    }
  }

  /** Record one completed tool invocation (success or error). */
  invocation(record: Omit<ToolInvocationRecord, 'seq'>): void {
    try {
      appendInvocation(this.executionId, { ...record, seq: this.invocationSeq++ });
    } catch {
      // Never let tracing break the build.
    }
  }
}

export function createTracer(executionId: string): ExecutionTracer {
  return new ExecutionTracer(executionId);
}

// ── Metrics aggregation ────────────────────────────────────────────────────

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
  /** Wall-clock time from execution creation to last update. */
  wall_clock_ms: number;
}

export function computeMetrics(record: ExecutionRecord): ObservabilityMetrics {
  const invocations = record.invocations ?? [];
  const events = record.trace ?? [];

  const byStatus: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let totalDuration = 0;
  let slowest: ObservabilityMetrics['slowest_invocation'] | undefined;

  for (const inv of invocations) {
    byStatus[inv.status] = (byStatus[inv.status] ?? 0) + 1;
    byTool[inv.tool] = (byTool[inv.tool] ?? 0) + 1;
    byCategory[inv.category] = (byCategory[inv.category] ?? 0) + 1;
    totalDuration += inv.durationMs;
    if (!slowest || inv.durationMs > slowest.duration_ms) {
      slowest = { tool: inv.tool, step_id: inv.stepId, duration_ms: inv.durationMs };
    }
  }

  const wallClock =
    new Date(record.updatedAt).getTime() - new Date(record.createdAt).getTime();

  return {
    total_events: events.length,
    total_invocations: invocations.length,
    invocations_by_status: byStatus,
    invocations_by_tool: byTool,
    invocations_by_category: byCategory,
    total_tool_duration_ms: totalDuration,
    avg_tool_duration_ms: invocations.length > 0 ? Math.round(totalDuration / invocations.length) : 0,
    slowest_invocation: slowest,
    wall_clock_ms: Number.isFinite(wallClock) && wallClock >= 0 ? wallClock : 0,
  };
}
