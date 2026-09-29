/**
 * GET /api/evals?limit=50&offset=0
 *
 * Lists recorded eval runs (`npm run eval:*`, written by
 * evals/lib/report.ts), newest first. Backed by lib/eval-store.ts. Used by
 * app/evals/page.tsx. Read-only — nothing here runs an eval.
 */

import { listEvalRuns } from '@/lib/eval-store';
import { ApiError, EvalRunsListResponse } from '@/lib/types';

export async function GET(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);

    const { evalRuns, total } = await listEvalRuns({ limit, offset });
    return Response.json({ evalRuns, total } as EvalRunsListResponse, { status: 200 });
  } catch (error) {
    console.error('[EVALS] Failed to list eval runs:', error);
    return Response.json(
      {
        error: `Failed to list eval runs: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
