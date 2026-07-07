/**
 * GET /api/executions/:id/status
 *
 * Returns the live status of a harness-driven execution directly from the
 * in-memory execution store (lib/execution-store.ts). There is no MCP
 * status tool being polled here — the harness itself is running the plan
 * (lib/execution-runner.ts) and this endpoint just reports its progress.
 *
 * Called frequently (every 2-3 seconds) from the frontend while running.
 */

import { getExecution, computeProgress, currentStepLabel } from '@/lib/execution-store';
import { StatusResponse, StepResponse, PlanningInfo, ApiError } from '@/lib/types';

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
        {
          error: `Execution not found: ${executionId}`,
          code: 'NOT_FOUND',
          details: {
            hint: 'Execution state is in-memory and process-local. If the harness restarted or is running as multiple instances, this execution id will not be found. See lib/execution-store.ts for details.',
          },
        } as ApiError,
        { status: 404 }
      );
    }

    const steps: StepResponse[] = record.steps.map((s) => ({
      id: s.id,
      label: s.label,
      tool: s.tool,
      category: s.category,
      critical: s.critical,
      status: s.status,
      result: s.result,
      error: s.error,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    }));

    const planning: PlanningInfo | undefined = record.planning
      ? {
          planning_mode: record.planning.planningMode,
          use_case: record.planning.useCase as PlanningInfo['use_case'],
          modules: record.planning.modules as PlanningInfo['modules'],
          module_order: record.planning.moduleOrder,
          llm_reasoning: record.planning.llmReasoning,
          llm_fallback_reason: record.planning.llmFallbackReason,
        }
      : undefined;

    const response: StatusResponse = {
      execution_id: record.id,
      status: record.status,
      progress: computeProgress(record),
      current_step: currentStepLabel(record),
      steps,
      error: record.error,
      planning,
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
