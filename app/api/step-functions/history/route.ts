/**
 * GET /api/step-functions/history?executionArn=...
 *
 * State-by-state transition history for one tool-call execution (see
 * infra/step-functions/) — powers the "view Step Functions history" panel
 * in AgentTrace. Not persisted anywhere; fetched live from AWS on demand.
 */

import { getExecutionHistory } from '@/lib/step-functions-client';
import { ApiError } from '@/lib/types';

export async function GET(request: Request): Promise<Response> {
  try {
    const executionArn = new URL(request.url).searchParams.get('executionArn');
    if (!executionArn) {
      return Response.json(
        { error: 'Missing required "executionArn" query parameter', code: 'VALIDATION_ERROR' } as ApiError,
        { status: 400 }
      );
    }

    const events = await getExecutionHistory(executionArn);
    return Response.json({ events }, { status: 200 });
  } catch (error) {
    console.error('[STEP_FUNCTIONS_HISTORY] Error:', error);
    return Response.json(
      {
        error: `Failed to get execution history: ${error instanceof Error ? error.message : String(error)}`,
        code: 'STEP_FUNCTIONS_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
