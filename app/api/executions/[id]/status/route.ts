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
import { StatusResponse, StepResponse, PlanningInfo, ObservabilitySummary, ApiError } from '@/lib/types';

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
          intent_notes: record.planning.intentNotes,
          modules: record.planning.modules as PlanningInfo['modules'],
          module_order: record.planning.moduleOrder,
          reasoning: record.planning.reasoning,
          synthesized_steps: record.planning.synthesizedSteps as PlanningInfo['synthesized_steps'],
          fallback_reason: record.planning.fallbackReason,
        }
      : undefined;

    const invocationsByStatus: Record<string, number> = {};
    let totalToolDurationMs = 0;
    for (const inv of record.invocations) {
      invocationsByStatus[inv.status] = (invocationsByStatus[inv.status] ?? 0) + 1;
      totalToolDurationMs += inv.durationMs;
    }
    const observability: ObservabilitySummary = {
      total_events: record.trace.length,
      total_invocations: record.invocations.length,
      invocations_by_status: invocationsByStatus,
      total_tool_duration_ms: totalToolDurationMs,
    };

    const response: StatusResponse = {
      execution_id: record.id,
      status: record.status,
      progress: computeProgress(record),
      current_step: currentStepLabel(record),
      steps,
      error: record.error,
      planning,
      observability,
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
