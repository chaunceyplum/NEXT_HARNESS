/**
 * POST /api/build
 * 
 * Accepts a user description and orchestrates the build process:
 * 1. Calls MCP planner to create SolutionConfig
 * 2. Calls MCP orchestrator to start execution
 * 3. Returns execution_id for status polling
 */

import { callMcpTool } from '@/lib/mcp-client';
import {
  BuildRequest,
  BuildResponse,
  PlannerParseResponse,
  OrchestratorExecuteResponse,
  ApiError,
  MCPError,
  ValidationError,
} from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  try {
    // Parse request body
    let body: BuildRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          error: 'Invalid JSON in request body',
          code: 'INVALID_JSON',
        } as ApiError,
        { status: 400 }
      );
    }

    // Validate required fields
    if (!body.description || typeof body.description !== 'string') {
      return Response.json(
        {
          error: 'Missing or invalid "description" field',
          code: 'VALIDATION_ERROR',
          details: {
            required: ['description'],
            received: body,
          },
        } as ApiError,
        { status: 400 }
      );
    }

    // Trim and validate description length
    const description = body.description.trim();
    if (description.length < 10) {
      return Response.json(
        {
          error: 'Description must be at least 10 characters',
          code: 'VALIDATION_ERROR',
          details: {
            minLength: 10,
            received: description.length,
          },
        } as ApiError,
        { status: 400 }
      );
    }

    if (description.length > 5000) {
      return Response.json(
        {
          error: 'Description must be less than 5000 characters',
          code: 'VALIDATION_ERROR',
          details: {
            maxLength: 5000,
            received: description.length,
          },
        } as ApiError,
        { status: 400 }
      );
    }

    console.log('[BUILD] Starting build process for description:', description.substring(0, 50) + '...');

    // Step 1: Call MCP planner
    console.log('[BUILD] Calling planner_parse_natural_language...');
    let planResponse: PlannerParseResponse;

    try {
      planResponse = await callMcpTool('planner_parse_natural_language', {
        user_input: description,
      });
    } catch (error) {
      console.error('[BUILD] Planner error:', error);
      return Response.json(
        {
          error: `Planner failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'PLANNER_ERROR',
        } as ApiError,
        { status: 500 }
      );
    }

    // Validate planner response
    if (!planResponse || !planResponse.solution_config) {
      console.error('[BUILD] Invalid planner response:', planResponse);
      return Response.json(
        {
          error: 'Planner returned invalid response',
          code: 'INVALID_RESPONSE',
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[BUILD] Planner response:', {
      domain: planResponse.solution_config.website_domain,
      vertical: planResponse.solution_config.business_vertical,
      eventsCount: planResponse.solution_config.events.length,
      segmentsCount: planResponse.solution_config.segments.length,
      confidence: planResponse.solution_config.confidence_score,
    });

    // Step 2: Call MCP orchestrator
    console.log('[BUILD] Calling orchestrator_execute...');
    let orchestratorResponse: OrchestratorExecuteResponse;

    try {
      orchestratorResponse = await callMcpTool('orchestrator_execute', {
        solution_config: planResponse.solution_config,
        skip_validation: false,
        dry_run: false,
      });
    } catch (error) {
      console.error('[BUILD] Orchestrator error:', error);
      return Response.json(
        {
          error: `Orchestrator failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'ORCHESTRATOR_ERROR',
        } as ApiError,
        { status: 500 }
      );
    }

    // Validate orchestrator response
    if (!orchestratorResponse || !orchestratorResponse.execution_id) {
      console.error('[BUILD] Invalid orchestrator response:', orchestratorResponse);
      return Response.json(
        {
          error: 'Orchestrator returned invalid response',
          code: 'INVALID_RESPONSE',
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[BUILD] Build started successfully:', {
      executionId: orchestratorResponse.execution_id,
      status: orchestratorResponse.status,
      estimatedDuration: orchestratorResponse.estimated_duration_seconds,
    });

    // Return success response
    const response: BuildResponse = {
      execution_id: orchestratorResponse.execution_id,
      status: orchestratorResponse.status,
      message: orchestratorResponse.message,
    };

    return Response.json(response, { status: 201 });
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
