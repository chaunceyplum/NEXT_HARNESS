/**
 * POST /api/runs/:id/resume
 *
 * Start a new run that continues an interrupted (or failed) one: same
 * request, plus what the earlier attempt already did (from its
 * checkpointed steps), with instructions not to repeat completed changes.
 * Streams the new run's events like POST /api/build; the new run id is in
 * its run_start event and the X-Run-Id header.
 */

import { getExecution } from '@/lib/execution-store';
import { resumeContextFrom, startBuildRun } from '@/lib/build-run';
import { runsBlockedReason } from '@/lib/kill-switch';
import { getJob, streamJob } from '@/lib/run-jobs';
import type { ApiError } from '@/lib/types';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const blocked = runsBlockedReason();
  if (blocked) return Response.json({ error: blocked, code: 'KILL_SWITCH' } as ApiError, { status: 503 });

  const record = await getExecution(id).catch(() => null);
  if (!record) return Response.json({ error: `Run not found: ${id}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
  if (record.status === 'completed' || getJob(id)?.done === false) {
    return Response.json(
      { error: `Run ${id} is ${getJob(id)?.done === false ? 'still running' : 'already completed'}; only interrupted or failed runs can be resumed`, code: 'NOT_RESUMABLE' } as ApiError,
      { status: 409 }
    );
  }

  // The original request, minus anything from an earlier resume, plus this run's history.
  const { resumeContext: _previous, ...original } = record.request;
  void _previous;
  const job = startBuildRun(
    { ...original, resumeContext: resumeContextFrom(record), resumedFrom: record.id },
    request.headers.get('x-harness-user') || 'anonymous'
  );
  return streamJob(job);
}
