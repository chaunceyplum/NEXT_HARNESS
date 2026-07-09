/**
 * GET /api/runs/:id
 *
 * Full record for one persisted agent run (request + result/error + trace),
 * used by app/results/[id]/page.tsx for the detail/replay view.
 */

import { getExecution } from '@/lib/execution-store';
import { ApiError } from '@/lib/types';

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

    const record = await getExecution(id.trim());
    if (!record) {
      return Response.json({ error: `Run not found: ${id}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
    }

    return Response.json(record, { status: 200 });
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
