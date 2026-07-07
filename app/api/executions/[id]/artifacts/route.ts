/**
 * GET /api/executions/:id/artifacts
 *
 * There are no generated files in this execution model — every step is a
 * live call to a real AEP / CJA / AJO tool that creates a real resource
 * (a schema, a dataset, a segment, a journey, etc.) in the connected Adobe
 * org. This endpoint returns a manifest of those created resources, built
 * directly from each completed step's raw result, instead of a nonexistent
 * "artifacts" tool.
 *
 * Only meaningful once the execution has finished (completed / failed /
 * completed_with_errors) — while running, it returns whatever has resolved
 * so far.
 */

import { getExecution } from '@/lib/execution-store';
import { ApiError } from '@/lib/types';

interface ResourceEntry {
  step_id: string;
  label: string;
  tool: string;
  category: 'rag' | 'aep' | 'cja' | 'ajo';
  status: string;
  result: any;
}

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
    const record = getExecution(executionId);

    if (!record) {
      return Response.json(
        { error: `Execution not found: ${executionId}`, code: 'NOT_FOUND' } as ApiError,
        { status: 404 }
      );
    }

    const resources: ResourceEntry[] = record.steps
      .filter((s) => s.status === 'completed' && s.result !== undefined)
      .map((s) => ({
        step_id: s.id,
        label: s.label,
        tool: s.tool,
        category: s.category,
        status: s.status,
        result: s.result,
      }));

    return Response.json(
      {
        execution_id: record.id,
        execution_status: record.status,
        resource_count: resources.length,
        resources,
      },
      { status: 200 }
    );
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
