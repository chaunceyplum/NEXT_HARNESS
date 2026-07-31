/**
 * POST /api/build
 *
 * Default (async): starts a Step Functions execution of harness-agent-loop
 * (aws/) and returns immediately with { runId, status: 'PENDING' }. The
 * agent loop itself — tool-RAG shortlisting, LLM-driven tool selection,
 * RAG-consulting retries — runs entirely in the Lambdas (aws/lambdas/);
 * this route no longer waits for any of it. Poll GET /api/runs/:runId for
 * progress (see that route for how the trace is derived from the run's
 * message history while in progress, and from the persisted result once
 * finalize has run).
 *
 * Validation + the actual StartExecution call live in lib/run-launcher.ts.
 *
 * ?sync=1: the original synchronous path — runs the whole agent loop
 * in-process via lib/llm/agent.ts and returns the full BuildResponse
 * directly. Useful for local testing without a deployed state machine, or
 * if HARNESS_STATE_MACHINE_ARN isn't set yet — see aws/README.md.
 */

import { runAgent } from '@/lib/llm/agent';
import { newRunId, saveExecution } from '@/lib/execution-store';
import { validateLaunchInput, launchRun } from '@/lib/run-launcher';
import { ApiError, BuildRequest, BuildResponse, ExecutionRecord, StartRunResponse } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  try {
    let body: BuildRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError,
        { status: 400 }
      );
    }

    const validationError = validateLaunchInput(body);
    if (validationError) {
      return Response.json(validationError.response, { status: validationError.status });
    }

    const isSync = new URL(request.url).searchParams.get('sync') === '1';

    if (isSync) {
      const description = body.description.trim();
      const allowFullBuild = body.allowFullBuild === true;
      const toolRetries = body.toolRetries ?? 1;

      console.log('[BUILD sync] Running agent for:', description.slice(0, 80));
      const runId = newRunId();
      const startedAt = Date.now();
      const createdAt = new Date(startedAt).toISOString();
      const normalizedRequest: BuildRequest = { description, model: body.model, allowFullBuild, toolRetries };

      let agentResult;
      try {
        agentResult = await runAgent({
          userInput: description,
          modelKey: body.model,
          allowFullBuild,
          toolRetries,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[BUILD sync] Agent run failed:', error);

        const failedRecord: ExecutionRecord = {
          id: runId,
          createdAt,
          description,
          model: body.model || 'unknown',
          allowFullBuild,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          request: normalizedRequest,
          error: message,
        };
        saveExecution(failedRecord).catch((err) => console.error('[BUILD sync] Failed to persist failed run:', err));

        return Response.json(
          { error: `Agent run failed: ${message}`, code: 'AGENT_ERROR', details: { runId } } as ApiError,
          { status: 500 }
        );
      }

      const response: BuildResponse = {
        runId,
        finalText: agentResult.finalText,
        steps: agentResult.steps,
        toolsConsidered: agentResult.toolsConsidered,
        executionId: agentResult.executionId,
        finishReason: agentResult.finishReason,
      };

      const completedRecord: ExecutionRecord = {
        id: runId,
        createdAt,
        description,
        model: body.model || 'unknown',
        allowFullBuild,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        toolsConsidered: agentResult.toolsConsidered,
        executionId: agentResult.executionId,
        request: normalizedRequest,
        result: response,
      };
      saveExecution(completedRecord).catch((err) => console.error('[BUILD sync] Failed to persist completed run:', err));

      return Response.json(response, { status: 200 });
    }

    // Async path (default) — InitRun creates the harness_agent_runs row;
    // this route never touches Postgres or the model provider directly.
    let runId: string;
    try {
      ({ runId } = await launchRun(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[BUILD] StartExecution failed:', error);
      return Response.json(
        { error: `Failed to start run: ${message}`, code: 'STEP_FUNCTIONS_ERROR' } as ApiError,
        { status: 500 }
      );
    }

    const response: StartRunResponse = { runId, status: 'PENDING' };
    return Response.json(response, { status: 202 });
  } catch (error) {
    console.error('[BUILD] Unexpected error:', error);
    return Response.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 500 }
    );
  }
}
