/**
 * GET /api/runs/:id/events?after=<seq>
 *
 * Reconnect to a run started in this process (lib/run-jobs.ts): replays its
 * buffered events after `after` (default: all), then streams live ones until
 * it finishes. 404 once the run is no longer held in memory; its persisted
 * record is at GET /api/runs/:id.
 */

import { getJob, streamJob } from '@/lib/run-jobs';
import type { ApiError } from '@/lib/types';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return Response.json(
      { error: `Run ${id} isn't live in this server; fetch its saved record from /api/runs/${id}`, code: 'NOT_LIVE' } as ApiError,
      { status: 404 }
    );
  }
  const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
  return streamJob(job, Number.isFinite(after) && after > 0 ? after : 0);
}
