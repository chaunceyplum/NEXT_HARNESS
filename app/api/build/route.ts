/**
 * POST /api/build
 *
 * Default (async): starts a Step Functions execution of harness-agent-loop
 * (aws/) and returns immediately with { runId, status: 'PENDING' }. The
 * agent loop itself — tool-RAG shortlisting, LLM-driven tool selection,
 * RAG-consulting retries, human-approval gates — runs entirely in the
 * Lambdas (aws/lambdas/); this route no longer waits for any of it.
 * Poll GET /api/runs/:runId for progress (see that route for how the trace
 * is derived from the run's message history while in progress, and from
 * the persisted result once finalize has run).
 *
 * ?sync=1: the original synchronous path — runs the whole agent loop
 * in-process via lib/llm/agent.ts and returns the full BuildResponse
 * directly. Kept only for side-by-side comparison during the Step
 * Functions cutover; delete once the async path is trusted (see the
 * migration's cleanup step).
 */

import { runAgent } from '@/lib/llm/agent';
import { getModelRegistry, getDefaultModelKey } from '@/lib/llm/model-registry';
import { newRunId, saveExecution } from '@/lib/execution-store';
import { startRun } from '@/lib/step-functions-client';
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

    if (!body.description || typeof body.description !== 'string') {
      return Response.json(
        {
          error: 'Missing or invalid "description" field',
          code: 'VALIDATION_ERROR',
          details: { required: ['description'] },
        } as ApiError,
        { status: 400 }
      );
    }

    const description = body.description.trim();
    if (description.length < 10) {
      return Response.json(
        {
          error: 'Description must be at least 10 characters',
          code: 'VALIDATION_ERROR',
          details: { minLength: 10, received: description.length },
        } as ApiError,
        { status: 400 }
      );
    }
    if (description.length > 5000) {
      return Response.json(
        {
          error: 'Description must be less than 5000 characters',
          code: 'VALIDATION_ERROR',
          details: { maxLength: 5000, received: description.length },
        } as ApiError,
        { status: 400 }
      );
    }

    if (body.model) {
      const known = getModelRegistry().some((entry) => entry.key === body.model);
      if (!known) {
        return Response.json(
          {
            error: `Unknown model "${body.model}"`,
            code: 'VALIDATION_ERROR',
            details: { available: getModelRegistry().map((entry) => entry.key) },
          } as ApiError,
          { status: 400 }
        );
      }
    }

    const runId = newRunId();
    const modelKey = body.model || getDefaultModelKey();
    const allowFullBuild = body.allowFullBuild === true;
    const maxSteps = body.maxSteps ?? 10;
    const toolShortlistSize = body.toolShortlistSize ?? 12;
    const toolRetries = body.toolRetries ?? 1;

    const isSync = new URL(request.url).searchParams.get('sync') === '1';

    if (isSync) {
      console.log('[BUILD sync] Running agent for:', description.slice(0, 80));
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
          model: modelKey,
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
        model: modelKey,
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
    try {
      await startRun({ runId, description, modelKey, allowFullBuild, maxSteps, toolShortlistSize, toolRetries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[BUILD] StartExecution failed:', error);
      return Response.json(
        { error: `Failed to start run: ${message}`, code: 'STEP_FUNCTIONS_ERROR', details: { runId } } as ApiError,
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
