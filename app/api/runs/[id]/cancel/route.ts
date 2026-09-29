/**
 * POST /api/runs/:id/cancel
 *
 * Stop a running agent run. Runs no longer stop when the browser
 * disconnects (lib/run-jobs.ts), so this is what the Stop button calls.
 */

import { cancelJob } from '@/lib/run-jobs';
import type { ApiError } from '@/lib/types';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const user = request.headers.get('x-harness-user') || 'anonymous';
  if (!cancelJob(id, `Stopped by ${user}.`)) {
    return Response.json({ error: `Run ${id} isn't running in this server`, code: 'NOT_RUNNING' } as ApiError, { status: 404 });
  }
  console.log(`[BUILD] Run ${id} stopped by ${user}`);
  return Response.json({ ok: true });
}
