/**
 * GET /api/executions/:id/artifacts
 * 
 * Retrieves the artifacts (generated files) from a completed execution
 * Called after orchestrator status shows COMPLETED
 */

import { callMcpTool } from '@/lib/mcp-client';
import {
  ArtifactsResponse,
  OrchestratorArtifactsResponse,
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

    console.log('[ARTIFACTS] Retrieving artifacts for execution:', executionId);

    // Call orchestrator to get artifacts
    let artifactsResponse: OrchestratorArtifactsResponse;

    try {
      artifactsResponse = await callMcpTool('orchestrator_get_artifacts', {
        execution_id: executionId,
      });
    } catch (error) {
      console.error('[ARTIFACTS] Orchestrator error:', error);

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

      // Check if artifacts are not available yet (execution still running)
      if (errorMessage.includes('not available') || errorMessage.includes('RUNNING')) {
        return Response.json(
          {
            error: 'Artifacts not available yet. Execution may still be running.',
            code: 'NOT_AVAILABLE',
          } as ApiError,
          { status: 202 }
        );
      }

      return Response.json(
        {
          error: `Failed to get artifacts: ${errorMessage}`,
          code: 'ORCHESTRATOR_ERROR',
        } as ApiError,
        { status: 500 }
      );
    }

    // Validate response
    if (!artifactsResponse || !Array.isArray(artifactsResponse.artifacts)) {
      console.error('[ARTIFACTS] Invalid orchestrator response:', artifactsResponse);
      return Response.json(
        {
          error: 'Orchestrator returned invalid response',
          code: 'INVALID_RESPONSE',
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[ARTIFACTS] Retrieved artifacts:', {
      executionId: executionId,
      count: artifactsResponse.artifacts.length,
      totalSize: artifactsResponse.summary.total_size_bytes,
    });

    // Format response
    const response: ArtifactsResponse = {
      artifacts: artifactsResponse.artifacts,
      total_artifacts: artifactsResponse.summary.total_artifacts,
      total_size_bytes: artifactsResponse.summary.total_size_bytes,
    };

    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[ARTIFACTS] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
