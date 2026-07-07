/**
 * GET /api/executions/:id/trace
 *
 * Full observability for a build: the ordered trace timeline (every
 * lifecycle transition, step outcome, and tool invocation event), the
 * per-tool-call invocation records (with timing, arg/output previews, and
 * errors), and aggregate metrics. Sourced from the in-memory execution
 * store, which lib/execution-runner.ts populates via lib/observability.ts
 * as the build runs.
 *
 * Same process-local caveat as the rest of the store: this reflects only
 * executions in the current process. The durable copy of the trace is the
 * structured server console log emitted alongside each event.
 */

import { getExecution } from '@/lib/execution-store';
import { computeMetrics } from '@/lib/observability';
import { TraceResponse, TraceEventResponse, ToolInvocationResponse, ApiError } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;

    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json(
        { error: 'Invalid execution ID', code: 'VALIDATION_ERROR', details: { received: id } } as ApiError,
        { status: 400 }
      );
    }

    const executionId = id.trim();
    const record = getExecution(executionId);

    if (!record) {
      return Response.json(
        {
          error: `Execution not found: ${executionId}`,
          code: 'NOT_FOUND',
          details: {
            hint: 'Trace state is in-memory and process-local. If the harness restarted or runs as multiple instances, this execution id will not be found. The durable trace copy is the structured server console log.',
          },
        } as ApiError,
        { status: 404 }
      );
    }

    const events: TraceEventResponse[] = record.trace.map((e) => ({
      seq: e.seq,
      timestamp: e.timestamp,
      level: e.level,
      type: e.type,
      message: e.message,
      step_id: e.stepId,
      tool: e.tool,
      category: e.category,
      duration_ms: e.durationMs,
      data: e.data,
    }));

    const invocations: ToolInvocationResponse[] = record.invocations.map((inv) => ({
      seq: inv.seq,
      step_id: inv.stepId,
      tool: inv.tool,
      category: inv.category,
      status: inv.status,
      args_preview: inv.argsPreview,
      output_preview: inv.outputPreview,
      output_bytes: inv.outputBytes,
      error: inv.error,
      duration_ms: inv.durationMs,
      started_at: inv.startedAt,
      completed_at: inv.completedAt,
    }));

    const response: TraceResponse = {
      execution_id: record.id,
      status: record.status,
      metrics: computeMetrics(record),
      events,
      invocations,
    };

    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[TRACE] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
