/**
 * GET /api/evals/:id
 *
 * One eval run plus every fixture-level result recorded for it. Used by
 * app/evals/[id]/page.tsx.
 */

import { getEvalRun } from '@/lib/eval-store';
import { ApiError } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!id || id.trim().length === 0) {
      return Response.json({ error: 'Invalid eval run ID', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
    }

    const run = await getEvalRun(id.trim());
    if (!run) {
      return Response.json({ error: `Eval run not found: ${id}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
    }

    return Response.json(run, { status: 200 });
  } catch (error) {
    console.error('[EVALS] Failed to get eval run:', error);
    return Response.json(
      {
        error: `Failed to get eval run: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
