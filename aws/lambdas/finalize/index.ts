/**
 * Finalize — the state machine's only exit point (Finalize / MarkExpired /
 * MarkFailed in the ASL all invoke this same Lambda with different
 * Parameters). Builds the same BuildResponse shape the old synchronous
 * agent produced (deriveTraceFromMessages, lib/llm/agent-core.ts) so the
 * existing /api/runs replay UI (AgentTrace component) renders a
 * Step-Functions-backed run identically to a synchronous one, then writes
 * it into harness_agent_runs' `result` column via finalizeRun.
 */

import { loadRun, finalizeRun } from '@/lib/execution-store';
import { deriveTraceFromMessages } from '@/lib/llm/agent-core';
import type { BuildResponse, RunLoopStatus } from '@/lib/types';

export interface FinalizeInput {
  runId: string;
  stepCount?: number;
  status?: 'DONE' | 'MAX_STEPS';
  maxSteps?: number;
  /** Set only by the ASL's MarkExpired/MarkFailed states — overrides the normal DONE/MAX_STEPS inference below. */
  forceStatus?: 'FAILED' | 'REJECTED';
  note?: string;
  /** Set only by MarkFailed — SFN's captured Error/Cause from whichever state's Catch routed here. */
  error?: { Error?: string; Cause?: string };
}

export const handler = async (event: FinalizeInput): Promise<{ runId: string; status: RunLoopStatus }> => {
  const { runId } = event;
  const run = await loadRun(runId);

  const status: RunLoopStatus = event.forceStatus ?? (event.status === 'MAX_STEPS' ? 'MAX_STEPS' : 'COMPLETED');
  const note =
    event.note ?? (event.error ? `${event.error.Error ?? 'Error'}: ${event.error.Cause ?? '(no cause)'}` : undefined);

  const { steps, finalText } = deriveTraceFromMessages(run.messages);
  const toolsConsidered = run.selectedTools.map((t) => t.name);

  const finishReason: BuildResponse['finishReason'] =
    status === 'COMPLETED' ? 'stop' : status === 'MAX_STEPS' ? 'length' : status === 'REJECTED' ? 'other' : 'error';

  const result: BuildResponse = {
    runId,
    finalText,
    steps,
    toolsConsidered,
    executionId: run.msbExecutionId ?? undefined,
    finishReason,
  };

  await finalizeRun(runId, {
    status,
    result,
    durationMs: Date.now() - new Date(run.createdAt).getTime(),
    toolsConsidered,
    executionId: run.msbExecutionId ?? undefined,
    error: note,
  });

  return { runId, status };
};
