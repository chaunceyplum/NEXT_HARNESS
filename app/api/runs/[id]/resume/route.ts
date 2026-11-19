/**
 * POST /api/runs/:id/resume
 *
 * Start a new run that continues an interrupted (or failed) one: same
 * request, plus what the earlier attempt already did (from its
 * checkpointed steps), with instructions not to repeat completed changes.
 * Streams the new run's events like POST /api/build; the new run id is in
 * its run_start event and the X-Run-Id header.
 */

import { getRun } from '@/lib/run-store';
import { resumeContextFrom, resumePlanFrom, startRun } from '@/lib/start-run';
import { runsBlockedReason } from '@/lib/kill-switch';
import { getJob, streamJob } from '@/lib/run-jobs';
import type { ApiError } from '@/lib/types';
import { isResumable } from '@/lib/run-lifecycle';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const blocked = runsBlockedReason();
  if (blocked) return Response.json({ error: blocked, code: 'KILL_SWITCH' } as ApiError, { status: 503 });

  const record = await getRun(id).catch(() => null);
  if (!record) return Response.json({ error: `Run not found: ${id}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
  const live = getJob(id)?.done === false;
  if (live || !isResumable(record.status)) {
    return Response.json(
      { error: `Run ${id} is ${live ? 'still running' : record.status}; only failed, cancelled or interrupted runs can be resumed`, code: 'NOT_RESUMABLE' } as ApiError,
      { status: 409 }
    );
  }

  // The original request, minus anything from an earlier resume, plus this run's history.
  const { resumeContext: _previous, resumePlan: _previousPlan, ...original } = record.request;
  void _previous;
  void _previousPlan;
  // An orchestrated run continues its stored plan, running only the steps
  // that are not done (Requirement 12.4).
  const resumePlan = resumePlanFrom(record);
  const job = startRun(
    { ...original, resumeContext: resumeContextFrom(record), resumedFrom: record.id, ...(resumePlan ? { resumePlan } : {}) },
    request.headers.get('x-harness-user') || 'anonymous'
  );
  return streamJob(job);
}
