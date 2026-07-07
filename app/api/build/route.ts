/**
 * POST /api/build
 *
 * Runs the dynamic agent (lib/llm/agent.ts) against a user description:
 *  1. Shortlists relevant MCP tools via semantic search over the tool catalog
 *  2. Lets the selected LLM (provider/model chosen per-request) call tools
 *     in a loop until it's done, instead of forcing every request through a
 *     fixed planner -> full-build pipeline
 *  3. Returns the step-by-step trace, plus an execution_id if the agent
 *     kicked off an async build (msb_execute_solution)
 */

import { runAgent } from '@/lib/llm/agent';
import { getModelRegistry } from '@/lib/llm/model-registry';
import { ApiError, BuildRequest, BuildResponse } from '@/lib/types';

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

    console.log('[BUILD] Running agent for:', description.slice(0, 80));

    let agentResult;
    try {
      agentResult = await runAgent({
        userInput: description,
        modelKey: body.model,
        allowFullBuild: body.allowFullBuild === true,
      });
    } catch (error) {
      console.error('[BUILD] Agent run failed:', error);
      return Response.json(
        {
          error: `Agent run failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'AGENT_ERROR',
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[BUILD] Agent finished:', {
      steps: agentResult.steps.length,
      toolsConsidered: agentResult.toolsConsidered,
      executionId: agentResult.executionId,
      finishReason: agentResult.finishReason,
    });

    const response: BuildResponse = {
      finalText: agentResult.finalText,
      steps: agentResult.steps,
      toolsConsidered: agentResult.toolsConsidered,
      executionId: agentResult.executionId,
      finishReason: agentResult.finishReason,
    };

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
