/**
 * InjectRejection — reached via the ASL's RequestApproval.Catch on
 * ErrorEquals: ["HumanRejected"] (POST /api/approvals/:id called
 * SendTaskFailure). Every pending tool call still needs a tool-result in
 * the message history — the model API rejects a dangling tool-call with no
 * result — so the rejection + human feedback becomes that result, the
 * human-feedback analogue of the RAG-consulting retry's _retryHistory:
 * revision context rides in-band so the next AgentStep revises instead of
 * repeating the identical call. See the added rule in
 * lib/llm/agent-core.ts's systemPrompt().
 */

import type { ModelMessage, ToolResultPart } from 'ai';
import { loadRun, checkpointStep } from '@/lib/execution-store';
import { asStateStoreError } from '../_shared/errors';
import type { LoopEnvelope } from '../_shared/envelope';

export interface InjectRejectionInput extends LoopEnvelope {
  /** Set by the Catch block's ResultPath: "$.error" — SFN's captured Error/Cause from SendTaskFailure. */
  error?: { Error?: string; Cause?: string };
}

/**
 * POST /api/approvals/:id sends SendTaskFailure with
 * cause = JSON.stringify({ feedback }). Step Functions may pass that
 * straight through as event.error.Cause, or wrap it as
 * {errorMessage: cause, errorType: 'HumanRejected'} depending on how deep
 * the failure propagated — handle both shapes rather than assuming one.
 */
function parseCauseFeedback(cause?: string): string | undefined {
  if (!cause) return undefined;
  try {
    const parsed: unknown = JSON.parse(cause);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { feedback?: unknown; errorMessage?: unknown };
      if (typeof obj.feedback === 'string') return obj.feedback;
      if (typeof obj.errorMessage === 'string') {
        try {
          const inner = JSON.parse(obj.errorMessage) as { feedback?: unknown };
          if (typeof inner.feedback === 'string') return inner.feedback;
        } catch {
          return obj.errorMessage;
        }
      }
    }
  } catch {
    return cause;
  }
  return cause;
}

export const handler = async (event: InjectRejectionInput): Promise<LoopEnvelope> => {
  const run = await asStateStoreError(() => loadRun(event.runId));
  const feedback = parseCauseFeedback(event.error?.Cause) ?? 'Rejected by reviewer (no feedback given)';

  const parts: ToolResultPart[] = (run.pendingToolCalls ?? []).map((call) => ({
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: 'error-text',
      value:
        `HUMAN REVIEWER REJECTED this action. Feedback: ${feedback}. ` +
        'Do not retry the same call unchanged — revise your approach per the feedback, ' +
        'or finish with an explanation if no compliant approach exists.',
    },
  }));

  const toolMessage: ModelMessage = { role: 'tool', content: parts };

  await asStateStoreError(() =>
    checkpointStep(event.runId, { newMessages: [toolMessage], pendingToolCalls: null, status: 'RUNNING' })
  );

  return { runId: event.runId, stepCount: event.stepCount, status: 'TOOL_CALLS', maxSteps: event.maxSteps };
};
