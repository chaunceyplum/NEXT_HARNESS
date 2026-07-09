/**
 * GET /api/runs?limit=20&offset=0
 *
 * Lists persisted agent runs (execution history), newest first. Backed by
 * lib/execution-store.ts. Used by app/results/page.tsx.
 */

import { listExecutions } from '@/lib/execution-store';
import { ApiError, RunsListResponse } from '@/lib/types';

export async function GET(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);

    const { runs, total } = await listExecutions({ limit, offset });
    return Response.json({ runs, total } as RunsListResponse, { status: 200 });
  } catch (error) {
    console.error('[RUNS] Failed to list runs:', error);
    return Response.json(
      {
        error: `Failed to list runs: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
