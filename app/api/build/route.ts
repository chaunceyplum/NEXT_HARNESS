/**
 * POST /api/build
 *
 * Runs the dynamic agent (lib/llm/agent.ts) against a user description:
 *  1. Shortlists relevant MCP tools via semantic search over the tool catalog
 *  2. Lets the selected LLM (provider/model chosen per-request) call tools
 *     in a loop until it's done, instead of forcing every request through a
 *     fixed planner pipeline
 *  3. Returns the step-by-step trace
 */

import { runAgent } from '@/lib/llm/agent';
import { getModelRegistry, getDefaultModelKey } from '@/lib/llm/model-registry';
import { newRunId, saveExecution } from '@/lib/execution-store';
import { ApiError, BuildRequest, BuildResponse, ExecutionRecord } from '@/lib/types';

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

    const MIN_TOOL_SHORTLIST_SIZE = 4;
    const MAX_TOOL_SHORTLIST_SIZE = 80;
    if (
      body.toolShortlistSize !== undefined &&
      (typeof body.toolShortlistSize !== 'number' ||
        !Number.isInteger(body.toolShortlistSize) ||
        body.toolShortlistSize < MIN_TOOL_SHORTLIST_SIZE ||
        body.toolShortlistSize > MAX_TOOL_SHORTLIST_SIZE)
    ) {
      return Response.json(
        {
          error: `"toolShortlistSize" must be an integer between ${MIN_TOOL_SHORTLIST_SIZE} and ${MAX_TOOL_SHORTLIST_SIZE}`,
          code: 'VALIDATION_ERROR',
          details: { min: MIN_TOOL_SHORTLIST_SIZE, max: MAX_TOOL_SHORTLIST_SIZE },
        } as ApiError,
        { status: 400 }
      );
    }

    const MIN_MAX_STEPS = 1;
    const MAX_MAX_STEPS = 50;
    if (
      body.maxSteps !== undefined &&
      (typeof body.maxSteps !== 'number' ||
        !Number.isInteger(body.maxSteps) ||
        body.maxSteps < MIN_MAX_STEPS ||
        body.maxSteps > MAX_MAX_STEPS)
    ) {
      return Response.json(
        {
          error: `"maxSteps" must be an integer between ${MIN_MAX_STEPS} and ${MAX_MAX_STEPS}`,
          code: 'VALIDATION_ERROR',
          details: { min: MIN_MAX_STEPS, max: MAX_MAX_STEPS },
        } as ApiError,
        { status: 400 }
      );
    }

    console.log('[BUILD] Running agent for:', description.slice(0, 80));

    const runId = newRunId();
    const startedAt = Date.now();
    const createdAt = new Date(startedAt).toISOString();
    const normalizedRequest: BuildRequest = {
      description,
      model: body.model,
      toolRetries: body.toolRetries,
      toolShortlistSize: body.toolShortlistSize,
      maxSteps: body.maxSteps,
    };

    let agentResult;
    try {
      agentResult = await runAgent({
        userInput: description,
        modelKey: body.model,
        toolRetries: body.toolRetries,
        toolShortlistSize: body.toolShortlistSize,
        maxSteps: body.maxSteps,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[BUILD] Agent run failed:', error);

      const failedRecord: ExecutionRecord = {
        id: runId,
        createdAt,
        description,
        model: body.model || getDefaultModelKey(),
        allowFullBuild: false,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        request: normalizedRequest,
        error: message,
      };
      saveExecution(failedRecord).catch((err) => console.error('[BUILD] Failed to persist failed run:', err));

      return Response.json(
        {
          error: `Agent run failed: ${message}`,
          code: 'AGENT_ERROR',
          details: { runId },
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[BUILD] Agent finished:', {
      runId,
      steps: agentResult.steps.length,
      toolsConsidered: agentResult.toolsConsidered,
      finishReason: agentResult.finishReason,
      usage: agentResult.usage,
    });

    const response: BuildResponse = {
      runId,
      finalText: agentResult.finalText,
      steps: agentResult.steps,
      toolsConsidered: agentResult.toolsConsidered,
      finishReason: agentResult.finishReason,
      usage: agentResult.usage,
    };

    const completedRecord: ExecutionRecord = {
      id: runId,
      createdAt,
      description,
      model: body.model || getDefaultModelKey(),
      allowFullBuild: false,
      status: 'completed',
      durationMs: Date.now() - startedAt,
      toolsConsidered: agentResult.toolsConsidered,
      request: normalizedRequest,
      result: response,
    };
    saveExecution(completedRecord).catch((err) => console.error('[BUILD] Failed to persist completed run:', err));

    return Response.json(response, { status: 200 });
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
