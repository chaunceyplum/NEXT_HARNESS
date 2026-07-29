/**
 * RequestApproval — invoked via arn:aws:states:::lambda:invoke.waitForTaskToken.
 * Returning from this handler does NOT resume the workflow; only
 * POST /api/approvals/:id calling SendTaskSuccess/SendTaskFailure with
 * event.taskToken does (see app/api/approvals/[id]/route.ts). This handler's
 * only job is to persist the token + the gated calls + why the model
 * proposed them, so a human has something to review.
 */

import { randomUUID } from 'crypto';
import { loadRun, createApproval } from '@/lib/execution-store';
import { asStateStoreError } from '../_shared/errors';

export interface RequestApprovalInput {
  taskToken: string;
  runId: string;
  stepCount: number;
}

interface MessageLike {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

/** The model's stated reasoning for proposing the gated call(s) — the last assistant message's text, not a separate stored field. */
function extractReasoningText(messages: MessageLike[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return '';
  if (typeof lastAssistant.content === 'string') return lastAssistant.content;
  return lastAssistant.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as unknown as { text: string }).text)
    .join('\n');
}

export const handler = async (event: RequestApprovalInput): Promise<void> => {
  const run = await asStateStoreError(() => loadRun(event.runId));
  const reasoning = extractReasoningText(run.messages as MessageLike[]);

  await asStateStoreError(() =>
    createApproval({
      id: randomUUID(),
      runId: event.runId,
      taskToken: event.taskToken,
      gatedCalls: run.pendingToolCalls ?? [],
      reasoning,
    })
  );

  const topicArn = process.env.HARNESS_APPROVALS_TOPIC_ARN;
  if (!topicArn) return;

  // Optional — only wired up if HARNESS_APPROVALS_TOPIC_ARN is set. Never
  // blocks the approval record from being created if it fails.
  try {
    const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
    const toolNames = (run.pendingToolCalls ?? []).map((c) => c.toolName).join(', ');
    await new SNSClient({}).send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: 'Harness approval needed',
        Message: `Run ${event.runId} is waiting on approval for: ${toolNames || '(no tool calls?)'}`,
      })
    );
  } catch (err) {
    console.error('[request-approval] SNS notification failed (non-fatal):', err);
  }
};
