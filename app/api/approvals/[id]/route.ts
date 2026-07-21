/**
 * POST /api/approvals/:id  { decision: 'approve' | 'reject', feedback?: string }
 *
 * Resolves a pending RequestApproval task. loadApproval() (server-side
 * only) is the one place task_token is ever read — it's used here to call
 * SendTaskSuccess/SendTaskFailure and then discarded; the response body
 * never includes it.
 */

import { loadApproval, resolveApproval } from '@/lib/execution-store';
import { approveTask, rejectTask } from '@/lib/step-functions-client';
import { ApiError } from '@/lib/types';

interface ApprovalDecisionRequest {
  decision: 'approve' | 'reject';
  feedback?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json({ error: 'Invalid approval ID', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
    }
    const approvalId = id.trim();

    let body: ApprovalDecisionRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
    }

    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return Response.json(
        { error: 'decision must be "approve" or "reject"', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }

    let approval;
    try {
      approval = await loadApproval(approvalId);
    } catch {
      return Response.json({ error: `Approval not found: ${approvalId}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
    }

    if (approval.status !== 'PENDING') {
      return Response.json(
        { error: `Approval already resolved (${approval.status})`, code: 'ALREADY_RESOLVED' } as ApiError,
        { status: 409 }
      );
    }

    if (body.decision === 'approve') {
      await approveTask(approval.taskToken);
      await resolveApproval(approvalId, 'APPROVED');
      return Response.json({ id: approvalId, status: 'APPROVED' }, { status: 200 });
    }

    const feedback = body.feedback?.trim() || 'Rejected by reviewer';
    await rejectTask(approval.taskToken, feedback);
    await resolveApproval(approvalId, 'REJECTED', feedback);
    return Response.json({ id: approvalId, status: 'REJECTED' }, { status: 200 });
  } catch (error) {
    console.error('[APPROVALS] Failed to resolve:', error);
    return Response.json(
      {
        error: `Failed to resolve approval: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
