/**
 * GET /api/executions
 *
 * Lists all harness-driven executions known to this process, most recent
 * first, with a lightweight summary of each (status, progress, step
 * counts) suitable for a list/dashboard view. For full step-by-step detail
 * on a single execution, use GET /api/executions/:id/status.
 *
 * NOTE: reads from the same process-local in-memory store as the rest of
 * the execution model (lib/execution-store.ts) — only reflects executions
 * created since this process last started. See that file's header for the
 * multi-instance/serverless caveat.
 */

import { listExecutions, computeProgress } from '@/lib/execution-store';
import { ExecutionSummary, ListExecutionsResponse, ApiError } from '@/lib/types';

export async function GET(): Promise<Response> {
  try {
    const records = listExecutions();

    const executions: ExecutionSummary[] = records.map((record) => {
      const completedStepCount = record.steps.filter((s) => s.status === 'completed').length;
      const failedStepCount = record.steps.filter((s) => s.status === 'failed').length;

      return {
        execution_id: record.id,
        description: record.description,
        status: record.status,
        progress: computeProgress(record),
        website_domain: record.solutionConfig?.website_domain,
        business_vertical: record.solutionConfig?.business_vertical,
        step_count: record.steps.length,
        completed_step_count: completedStepCount,
        failed_step_count: failedStepCount,
        planning_mode: record.planning?.planningMode,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      };
    });

    const response: ListExecutionsResponse = {
      executions,
      total: executions.length,
    };

    return Response.json(response, { status: 200 });
  } catch (error) {
    console.error('[EXECUTIONS LIST] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
