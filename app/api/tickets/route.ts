/**
 * POST /api/tickets  { title, description, priority?, requester?, team?, tags?, dueAt?, model?, allowFullBuild?, autonomous? }
 * GET  /api/tickets?limit=&offset=
 *
 * A ticket is a durable, metadata-carrying wrapper around a run — see the
 * Ticket doc comment in lib/types.ts. Submitting one launches its run
 * immediately (lib/run-launcher.ts, the same path POST /api/build uses);
 * there is no separate queue/dispatch step — a ticket's status is always
 * read live off its run (lib/execution-store.ts's listTickets/getTicket).
 */

import { randomUUID } from 'crypto';
import { createTicket, listTickets } from '@/lib/execution-store';
import { validateLaunchInput, launchRun } from '@/lib/run-launcher';
import { ApiError, CreateTicketRequest, CreateTicketResponse, TicketPriority, TicketsListResponse } from '@/lib/types';

const VALID_PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

export async function POST(request: Request): Promise<Response> {
  try {
    let body: CreateTicketRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError,
        { status: 400 }
      );
    }

    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return Response.json(
        { error: 'Missing or invalid "title" field', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }
    if (body.title.length > 200) {
      return Response.json(
        { error: 'Title must be 200 characters or fewer', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      return Response.json(
        {
          error: `Invalid priority "${body.priority}"`,
          code: 'VALIDATION_ERROR',
          details: { available: VALID_PRIORITIES },
        } as ApiError,
        { status: 400 }
      );
    }

    const validationError = validateLaunchInput(body);
    if (validationError) {
      return Response.json(validationError.response, { status: validationError.status });
    }

    let runId: string;
    try {
      ({ runId } = await launchRun(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[TICKETS] StartExecution failed:', error);
      return Response.json(
        { error: `Failed to start run: ${message}`, code: 'STEP_FUNCTIONS_ERROR' } as ApiError,
        { status: 500 }
      );
    }

    // The run is already underway by this point — a failure below can no
    // longer be "nothing happened," only "the ticket record didn't save."
    const ticketId = randomUUID();
    try {
      await createTicket({
        id: ticketId,
        runId,
        title: body.title.trim(),
        description: body.description,
        priority: body.priority ?? 'normal',
        requester: body.requester?.trim() || undefined,
        team: body.team?.trim() || undefined,
        tags: body.tags,
        dueAt: body.dueAt,
      });
    } catch (error) {
      console.error('[TICKETS] Ticket record failed to save (run already started):', error);
      return Response.json(
        {
          error: `Run started (${runId}) but the ticket record failed to save: ${error instanceof Error ? error.message : String(error)}`,
          code: 'TICKET_PERSIST_ERROR',
          details: { runId },
        } as ApiError,
        { status: 500 }
      );
    }

    const response: CreateTicketResponse = { id: ticketId, runId, status: 'PENDING' };
    return Response.json(response, { status: 202 });
  } catch (error) {
    console.error('[TICKETS] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const { tickets, total } = await listTickets({ limit, offset });
    const response: TicketsListResponse = { tickets, total };
    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[TICKETS] Failed to list:', error);
    return Response.json(
      {
        error: `Failed to list tickets: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
