/**
 * GET /api/executions/:id/status
 *
 * Polls msb_get_execution_status for a build kicked off via
 * msb_execute_solution. Only reachable when the agent actually returned an
 * execution_id (i.e. a full end-to-end build was explicitly allowed and
 * triggered) — most agent runs resolve inline and never hit this route.
 *
 * The exact response shape of msb_get_execution_status hasn't been verified
 * against a live execution, so this passes the raw result through rather
 * than assuming a rigid structure.
 */

import { callMcpTool } from '@/lib/mcp-client';
import { ApiError, ExecutionStatus } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;

    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json(
        { error: 'Invalid execution ID', code: 'VALIDATION_ERROR', details: { received: id } } as ApiError,
        { status: 400 }
      );
    }

    const executionId = id.trim();
    console.log('[STATUS] Polling status for execution:', executionId);

    let raw: unknown;
    try {
      raw = await callMcpTool('msb_get_execution_status', { execution_id: executionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[STATUS] msb_get_execution_status error:', message);

      if (message.toLowerCase().includes('not found')) {
        return Response.json(
          { error: `Execution not found: ${executionId}`, code: 'NOT_FOUND' } as ApiError,
          { status: 404 }
        );
      }

      return Response.json(
        { error: `Failed to get status: ${message}`, code: 'MCP_ERROR' } as ApiError,
        { status: 500 }
      );
    }

    if (!raw || typeof raw !== 'object') {
      console.error('[STATUS] Unexpected response from msb_get_execution_status:', raw);
      return Response.json(
        { error: 'msb_get_execution_status returned an unexpected response', code: 'INVALID_RESPONSE', details: { received: raw } } as ApiError,
        { status: 500 }
      );
    }

    const status: ExecutionStatus = { execution_id: executionId, ...(raw as Record<string, unknown>) };
    return Response.json(status, { status: 200 });
  } catch (error) {
    console.error('[STATUS] Unexpected error:', error);
    return Response.json(
      { error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`, code: 'INTERNAL_ERROR' } as ApiError,
      { status: 500 }
    );
  }
}
