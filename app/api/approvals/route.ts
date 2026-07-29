/**
 * GET /api/approvals
 *
 * Pending human-approval gates across all runs (app/approvals/page.tsx).
 * listPendingApprovals() never selects task_token — nothing here can leak
 * the SendTaskSuccess/Failure bearer credential to the client.
 */

import { listPendingApprovals } from '@/lib/execution-store';
import { ApiError } from '@/lib/types';

export async function GET(): Promise<Response> {
  try {
    const approvals = await listPendingApprovals();
    return Response.json({ approvals }, { status: 200 });
  } catch (error) {
    console.error('[APPROVALS] Failed to list:', error);
    return Response.json(
      {
        error: `Failed to list approvals: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
