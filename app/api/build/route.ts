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
    if (!planResponse) {
      console.error('[BUILD] Planner returned null/undefined');
      return Response.json(
        {
          error: 'Planner returned null or undefined response',
          code: 'INVALID_RESPONSE',
          details: { received: planResponse },
        } as ApiError,
        { status: 500 }
      );
    }

    // Check response structure - could be nested differently
    let solutionConfig = planResponse.solution_config || planResponse;
    
    if (!solutionConfig || typeof solutionConfig !== 'object') {
      console.error('[BUILD] Invalid response structure:', planResponse);
      return Response.json(
        {
          error: 'Planner returned invalid response structure',
          code: 'INVALID_RESPONSE',
          details: {
            received: planResponse,
            expectedStructure: 'Object with solution_config field',
          },
        } as ApiError,
        { status: 500 }
      );
    }

    // Verify solution_config has required fields
    if (!solutionConfig.website_domain && !solutionConfig.business_vertical) {
      console.error('[BUILD] Missing required config fields:', solutionConfig);
      return Response.json(
        {
          error: 'Planner response missing required fields (website_domain, business_vertical)',
          code: 'INVALID_RESPONSE',
          details: { received: Object.keys(solutionConfig) },
        } as ApiError,
        { status: 500 }
      );
    }

    console.log('[BUILD] Planner response:', {
      domain: solutionConfig.website_domain,
      vertical: solutionConfig.business_vertical,
      eventsCount: solutionConfig.events?.length || 0,
      segmentsCount: solutionConfig.segments?.length || 0,
      confidence: solutionConfig.confidence_score,
    });

    // Step 2: Call MCP orchestrator
    console.log('[BUILD] Calling orchestrator_execute...');
    let orchestratorResponse: OrchestratorExecuteResponse;

    try {
      orchestratorResponse = await callMcpTool('orchestrator_execute', {
        solution_config: solutionConfig,
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
