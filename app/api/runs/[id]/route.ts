/**
 * GET /api/runs/:id
 *
 * Full record for one agent run, used by app/results/[id]/page.tsx for the
 * detail/replay/polling view. Two cases, same response shape:
 *
 *  - Terminal (old synchronous path, or a Step-Functions run finalize has
 *    already closed out): getExecution()'s `result` column already has the
 *    full BuildResponse — returned as-is.
 *  - Still in flight (Step Functions run: PENDING/RUNNING/
 *    AWAITING_APPROVAL/MAX_STEPS-not-yet-finalized): `result` is still
 *    null, so this derives a live BuildResponse from the run's message
 *    history (deriveTraceFromMessages) so the UI shows progress instead of
 *    nothing. Polling this route is what drives the run detail page.
 */

import { getExecution, loadRun } from '@/lib/execution-store';
import { deriveTraceFromMessages } from '@/lib/llm/agent-core';
import { ApiError, BuildResponse, ExecutionRecord } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json(
        { error: 'Invalid run ID', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }
    const runId = id.trim();

    const record = await getExecution(runId);
    if (!record) {
      return Response.json({ error: `Run not found: ${runId}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
    }

    if (record.result || record.status === 'failed') {
      // 'failed' is the old synchronous path's terminal status (see
      // app/api/build/route.ts's ?sync=1 branch) — it never populates
      // `result` but already carries `error`, so there's nothing to derive.
      return Response.json(record, { status: 200 });
    }

    // No result yet — either the old sync path's request genuinely hasn't
    // finished (shouldn't be observable, that route awaits it), or this is
    // a Step-Functions-backed run still in progress. Try to derive a live
    // view; fall back to the bare record if this row predates the
    // Step-Functions columns.
    try {
      const run = await loadRun(runId);
      const { steps, finalText } = deriveTraceFromMessages(run.messages);
      const liveResult: BuildResponse = {
        runId: run.id,
        finalText,
        steps,
        toolsConsidered: run.selectedTools.map((t) => t.name),
        executionId: run.msbExecutionId ?? undefined,
        finishReason: run.status,
      };
      const liveRecord: ExecutionRecord = { ...record, status: run.status, result: liveResult };
      return Response.json(liveRecord, { status: 200 });
    } catch {
      return Response.json(record, { status: 200 });
    }
  } catch (error) {
    console.error('[RUNS] Failed to get run:', error);
    return Response.json(
      {
        error: `Failed to get run: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
