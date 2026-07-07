/**
 * POST /api/executions/:id/cancel
 *
 * Cancels a running msb_execute_solution build and triggers rollback,
 * per msb_cancel_execution's description.
 */

import { callMcpTool } from '@/lib/mcp-client';
import { ApiError } from '@/lib/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json(
        { error: 'Invalid execution ID', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }

    const result = await callMcpTool('msb_cancel_execution', { execution_id: id.trim() });
    return Response.json(result, { status: 200 });
  } catch (error) {
    console.error('[CANCEL] Error:', error);
    return Response.json(
      { error: `Failed to cancel execution: ${error instanceof Error ? error.message : String(error)}`, code: 'MCP_ERROR' } as ApiError,
      { status: 500 }
    );
  }
}
