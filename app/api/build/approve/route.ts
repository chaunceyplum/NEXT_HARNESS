/**
 * POST /api/build/approve
 *
 * Approves or denies a destructive tool call that a streaming /api/build run
 * is paused on (announced by its `approval_request` event).
 *
 * Body: {"runId":"...","toolCallId":"...","approved":true}
 * 200 {"ok":true} — the run resumes; 404 if nothing is waiting on that call
 * (already decided, timed out, or the run ended); 403 if HARNESS_APPROVERS
 * is set and doesn't include the caller.
 */

import { resolveApproval } from '@/lib/llm/approvals';
import { mayApprove, requestUser } from '@/lib/auth';
import { ApiError } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.runId !== 'string' || typeof b.toolCallId !== 'string' || typeof b.approved !== 'boolean') {
    return Response.json(
      {
        error: '"runId" and "toolCallId" (strings) and "approved" (boolean) are required',
        code: 'VALIDATION_ERROR',
        details: { required: ['runId', 'toolCallId', 'approved'] },
      } as ApiError,
      { status: 400 }
    );
  }

  const user = requestUser(request);
  if (!mayApprove(user)) {
    return Response.json(
      { error: `"${user}" is not in HARNESS_APPROVERS, so cannot approve or deny tool calls`, code: 'FORBIDDEN' } as ApiError,
      { status: 403 }
    );
  }

  if (!resolveApproval(b.runId, b.toolCallId, b.approved, user)) {
    return Response.json(
      { error: 'No pending approval for that tool call (already decided, timed out, or the run ended)', code: 'NOT_FOUND' } as ApiError,
      { status: 404 }
    );
  }
  console.log(`[BUILD] Tool call ${b.toolCallId} on run ${b.runId} ${b.approved ? 'approved' : 'denied'} by ${user}`);
  return Response.json({ ok: true });
}
