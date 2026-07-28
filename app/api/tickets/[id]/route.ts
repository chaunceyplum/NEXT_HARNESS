/**
 * GET /api/tickets/:id
 *
 * The ticket (metadata joined live against its run's status — see
 * getTicket) plus its run's agent trace: the persisted BuildResponse if
 * finalize has already run, otherwise a trace derived live from the run's
 * message history — same approach as GET /api/runs/:id.
 */

import { getExecution, getTicket, loadRun } from '@/lib/execution-store';
import { deriveTraceFromMessages } from '@/lib/llm/agent-core';
import { ApiError, BuildResponse, TicketDetailResponse } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json({ error: 'Invalid ticket ID', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
    }

    const ticket = await getTicket(id.trim());
    if (!ticket) {
      return Response.json({ error: `Ticket not found: ${id}`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
    }

    const record = await getExecution(ticket.runId);
    let result: BuildResponse | undefined = record?.result;

    if (!result && ticket.runStatus !== 'failed') {
      try {
        const run = await loadRun(ticket.runId);
        const { steps, finalText } = deriveTraceFromMessages(run.messages);
        result = {
          runId: run.id,
          finalText,
          steps,
          toolsConsidered: run.selectedTools.map((t) => t.name),
          executionId: run.msbExecutionId ?? undefined,
          finishReason: run.status,
        };
      } catch {
        // Predates the Step-Functions columns, or the run row is otherwise
        // unreadable this way — fall through with result left undefined.
      }
    }

    const response: TicketDetailResponse = { ticket, result, error: record?.error };
    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[TICKETS] Failed to get ticket:', error);
    return Response.json(
      {
        error: `Failed to get ticket: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
