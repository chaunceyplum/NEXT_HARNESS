/**
 * POST /api/build
 *
 * Accepts a user description and starts a harness-driven build:
 * 1. Calls MCP planner_parse_natural_language to create a SolutionConfig.
 * 2. Plans the build dynamically per use case (lib/plan-builder.ts's
 *    capability modules, optionally refined by an LLM via
 *    lib/llm-planner.ts) — NOT one fixed workflow every time. Which
 *    modules (RAG/AEP/Launch/CJA/AJO activation/AJO offers) run, and in
 *    what order, depends on the actual SolutionConfig: an activation-heavy
 *    use case orders AJO earlier, an analytics-only use case may skip AJO
 *    entirely, a personalization use case pulls in AJO offers instead of
 *    (or alongside) journeys, etc.
 * 3. Starts executing that plan (lib/execution-runner.ts) and returns an
 *    execution_id immediately for status polling, along with a `planning`
 *    block explaining which modules were included/skipped and why, and
 *    whether an LLM or the deterministic heuristic decided the order.
 *
 * NOTE ON EXECUTION MODEL:
 * There is no MCP orchestrator tool. msb_execute_solution exists in the MCP
 * but (a) cannot be safely invoked over JSON-RPC because the dispatcher's
 * generic string-to-JSON auto-parsing collides with its own manual
 * json.loads() of config_json, and (b) is bound by the Lambda's 30s
 * timeout, which a 9-phase build cannot complete within regardless. Per
 * explicit instruction, the MCP is not being modified — so "execute
 * solution" now lives in the harness itself, calling individual AEP / CJA /
 * AJO / RAG tools directly.
 */

import { randomUUID } from 'crypto';
import { callMcpTool } from '@/lib/mcp-client';
import { planBuildAsync } from '@/lib/llm-planner';
import { runPlan } from '@/lib/execution-runner';
import { createExecution, ExecutionPlanningInfo } from '@/lib/execution-store';
import { createTracer } from '@/lib/observability';
import { BuildRequest, BuildResponse, PlanningInfo, ApiError } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  try {
    // Parse request body
    let body: BuildRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError,
        { status: 400 }
      );
    }

    // Validate required fields
    if (!body.description || typeof body.description !== 'string') {
      return Response.json(
        {
          error: 'Missing or invalid "description" field',
          code: 'VALIDATION_ERROR',
          details: { required: ['description'], received: body },
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

    console.log('[BUILD] Starting build for description:', description.substring(0, 50) + '...');

    // Step 1: Call MCP planner
    let planResponse: any;
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

    if (!planResponse || typeof planResponse !== 'object') {
      console.error('[BUILD] Planner returned invalid response:', planResponse);
      return Response.json(
        {
          error: 'Planner returned null, undefined, or non-object response',
          code: 'INVALID_RESPONSE',
          details: { received: planResponse },
        } as ApiError,
        { status: 500 }
      );
    }

    const solutionConfig = planResponse.solution_config || planResponse;

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

    const missingFields: string[] = [];
    if (!solutionConfig.website_domain) missingFields.push('website_domain');
    if (!solutionConfig.business_vertical) missingFields.push('business_vertical');

    if (missingFields.length > 0) {
      console.error('[BUILD] Missing required config fields:', missingFields, 'Config:', solutionConfig);
      return Response.json(
        {
          error: `Planner response missing required fields (${missingFields.join(', ')})`,
          code: 'INVALID_RESPONSE',
          details: {
            missingFields,
            availableFields: Object.keys(solutionConfig),
            received: solutionConfig,
          },
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

    // Step 2: Plan the build DYNAMICALLY for this specific request.
    // planBuildAsync (a) enriches the regex-collapsed config with intent
    // read from the RAW description, then (b) if ANTHROPIC_API_KEY is set,
    // asks an LLM to synthesize a request-specific tool plan validated
    // against the tool catalog, else (c) falls back to the deterministic
    // capability-module heuristic run against the enriched config. It
    // always resolves. Different requests now produce different plans —
    // different tools, counts, and arguments — not one fixed template.
    const plan = await planBuildAsync(description, solutionConfig);
    const { steps } = plan;

    if (steps.length === 0) {
      return Response.json(
        {
          error: 'Planner produced a config with no actionable steps',
          code: 'EMPTY_PLAN',
        } as ApiError,
        { status: 500 }
      );
    }

    const orderPreview =
      plan.planningMode === 'llm_synthesized'
        ? steps.map((s) => s.tool).join(' -> ')
        : (plan.moduleOrder ?? []).join(' -> ');

    console.log('[BUILD] Plan:', {
      planningMode: plan.planningMode,
      useCaseSummary: plan.useCase.summary,
      intentNotes: plan.intentNotes,
      stepCount: steps.length,
      tools: steps.map((s) => s.tool),
      fallbackReason: plan.fallbackReason,
    });

    const use_case = {
      activation_focused: plan.useCase.activationFocused,
      analytics_focused: plan.useCase.analyticsFocused,
      personalization_focused: plan.useCase.personalizationFocused,
      needs_data_collection: plan.useCase.needsDataCollection,
      summary: plan.useCase.summary,
    };

    const synthesizedSteps =
      plan.planningMode === 'llm_synthesized'
        ? steps.map((s) => ({ id: s.id, label: s.label, tool: s.tool, category: s.category }))
        : undefined;

    const modules =
      plan.planningMode === 'heuristic'
        ? (plan.modules ?? []).map((m) => ({
            id: m.id,
            label: m.label,
            included: m.included,
            reason: m.reason,
            step_count: m.stepCount,
          }))
        : undefined;

    const planningInfo: PlanningInfo = {
      planning_mode: plan.planningMode,
      use_case,
      intent_notes: plan.intentNotes,
      modules,
      module_order: plan.moduleOrder,
      reasoning: plan.reasoning,
      synthesized_steps: synthesizedSteps,
      fallback_reason: plan.fallbackReason,
    };

    const storedPlanning: ExecutionPlanningInfo = {
      planningMode: plan.planningMode,
      useCase: use_case,
      intentNotes: plan.intentNotes,
      modules,
      moduleOrder: plan.moduleOrder,
      reasoning: plan.reasoning,
      synthesizedSteps,
      fallbackReason: plan.fallbackReason,
    };

    // Step 3: Register the execution and start running it.
    // The runner executes sequentially and updates the in-memory store as it
    // goes; we do not await it here so the request can return immediately
    // and the client can poll /api/executions/:id/status.
    const executionId = randomUUID();
    createExecution(executionId, description, solutionConfig, steps, storedPlanning);

    // Observability: record creation + the planning decision before the
    // runner takes over (the runner emits execution.started onward).
    const tracer = createTracer(executionId);
    tracer.event('execution.created', `Execution created for "${solutionConfig.website_domain}" (${solutionConfig.business_vertical}).`, {
      data: {
        domain: solutionConfig.website_domain,
        vertical: solutionConfig.business_vertical,
        stepCount: steps.length,
      },
    });
    tracer.event('planning.decided', `Planned via ${plan.planningMode}: ${orderPreview}`, {
      data: {
        planningMode: plan.planningMode,
        useCaseSummary: plan.useCase.summary,
        intentNotes: plan.intentNotes,
        tools: steps.map((s) => s.tool),
        reasoning: plan.reasoning,
        fallbackReason: plan.fallbackReason,
      },
    });

    runPlan(executionId, steps).catch((err) => {
      // Defensive: runPlan already handles per-step errors internally, but
      // guard against anything unexpected escaping it so it doesn't crash
      // the process or become an unhandled rejection.
      console.error(`[BUILD] Unexpected error running plan for ${executionId}:`, err);
    });

    console.log('[BUILD] Execution started:', { executionId, stepCount: steps.length });

    const response: BuildResponse = {
      execution_id: executionId,
      status: 'running',
      message: `Build started with ${steps.length} steps, planned via ${plan.planningMode === 'llm_synthesized' ? 'LLM synthesis from your request' : 'the deterministic heuristic'}.`,
      step_count: steps.length,
      planning: planningInfo,
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
