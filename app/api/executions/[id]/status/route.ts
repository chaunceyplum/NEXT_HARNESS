/**
 * GET /api/executions/:id/status
 * 
 * Polls the orchestrator for execution status
 * Called frequently (every 2-5 seconds) from the frontend
 */

import { callMcpTool } from '@/lib/mcp-client';
import {
  StatusResponse,
  OrchestratorStatusResponse,
  ApiError,
} from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;

    // Validate execution ID format
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Response.json(
        {
          error: 'Invalid execution ID',
          code: 'VALIDATION_ERROR',
          details: { received: id },
        } as ApiError,
        { status: 400 }
      );
    }

    const executionId = id.trim();

    console.log('[STATUS] Polling status for execution:', executionId);

    // Call orchestrator to get status
    let orchestratorStatus: OrchestratorStatusResponse;

    try {
      orchestratorStatus = await callMcpTool('orchestrator_get_status', {
        execution_id: executionId,
      });
    } catch (error) {
      console.error('[STATUS] Orchestrator error:', error);

      // Check if it's a "not found" error
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('not found') || errorMessage.includes('NOT_FOUND')) {
        return Response.json(
          {
            error: `Execution not found: ${executionId}`,
            code: 'NOT_FOUND',
          } as ApiError,
          { status: 404 }
        );
      }

      return Response.json(
        {
          error: `Failed to get status: ${errorMessage}`,
          code: 'ORCHESTRATOR_ERROR',
        } as ApiError,
        { status: 500 }
      );
    }

    // Validate orchestrator response
    if (!orchestratorStatus) {
      console.error('[STATUS] Invalid orchestrator response:', orchestratorStatus);
      return Response.json(
        {
          error: 'Orchestrator returned invalid response',
          code: 'INVALID_RESPONSE',
        } as ApiError,
        { status: 500 }
      );
    }

    // Log status for debugging
    if (orchestratorStatus.status === 'COMPLETED' || orchestratorStatus.status === 'FAILED') {
      console.log('[STATUS] Execution finished:', {
        executionId: orchestratorStatus.execution_id,
        status: orchestratorStatus.status,
        phase: orchestratorStatus.current_phase,
        error: orchestratorStatus.error,
      });
    } else {
      console.log('[STATUS] Execution running:', {
        executionId: orchestratorStatus.execution_id,
        status: orchestratorStatus.status,
        phase: orchestratorStatus.current_phase,
        progress: orchestratorStatus.progress,
        phaseNumber: orchestratorStatus.phase_number,
      });
    }

    // Format response
    const response: StatusResponse = {
      execution_id: orchestratorStatus.execution_id,
      status: orchestratorStatus.status,
      current_phase: orchestratorStatus.current_phase,
      phase_number: orchestratorStatus.phase_number,
      total_phases: orchestratorStatus.total_phases,
      progress: orchestratorStatus.progress,
      logs: orchestratorStatus.logs || [],
      error: orchestratorStatus.error,
    };

    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[STATUS] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
