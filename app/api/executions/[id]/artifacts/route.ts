/**
 * GET /api/executions/:id/artifacts
 *
 * There is no dedicated "get artifacts" tool on the MCP (the old
 * orchestrator_get_artifacts this route used to call doesn't exist).
 * msb_execute_solution's description implies it commits/deploys as part of
 * the build rather than returning downloadable files, so this best-effort
 * reads whatever msb_get_execution_status returns and looks for anything
 * that looks like artifacts (an `artifacts`/`files`/`outputs` array).
 *
 * Verify this against a real execution and tighten it once you know the
 * actual shape — until then, the UI should treat a missing/empty result
 * here as normal, not an error.
 */

import { callMcpTool } from '@/lib/mcp-client';
import { ApiError, Artifact } from '@/lib/types';

const CANDIDATE_KEYS = ['artifacts', 'files', 'outputs', 'generated_files'];

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

    let raw: unknown;
    try {
      raw = await callMcpTool('msb_get_execution_status', { execution_id: executionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('not found')) {
        return Response.json(
          { error: `Execution not found: ${executionId}`, code: 'NOT_FOUND' } as ApiError,
          { status: 404 }
        );
      }
      return Response.json(
        { error: `Failed to get execution status: ${message}`, code: 'MCP_ERROR' } as ApiError,
        { status: 500 }
      );
    }

    let artifacts: Artifact[] = [];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      for (const key of CANDIDATE_KEYS) {
        if (Array.isArray(obj[key])) {
          artifacts = obj[key] as Artifact[];
          break;
        }
      }
    }

    return Response.json({ artifacts, raw }, { status: 200 });
  } catch (error) {
    console.error('[ARTIFACTS] Unexpected error:', error);
    return Response.json(
      { error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`, code: 'INTERNAL_ERROR' } as ApiError,
      { status: 500 }
    );
  }
}
