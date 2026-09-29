/**
 * POST /api/build
 *
 * TASK 8: Streaming response. Instead of blocking until the full agent run
 * completes, this route returns a streaming response of newline-delimited JSON
 * (NDJSON) events so the client can render each step as it arrives.
 *
 * Event sequence:
 *   {"type":"run_start","runId":"...","toolsConsidered":["..."]}
 *   {"type":"text_delta","delta":"..."}    // TASK 1: assistant text as it streams
 *   {"type":"step","step":{...}}           // one per agent step, as it finishes
 *   {"type":"step","step":{...}}
 *   ...
 *   {"type":"done","finalText":"...","finishReason":"stop","usage":{...},"runId":"...","modelKey":"...","toolsConsidered":[...],
 *    "stopReason":"token-budget"?,"budgetUsage":{"tokens":...,"costUsd":...,"durationMs":...}}
 *
 * When a tool call needs a human decision (lib/llm/approval-policy.ts; POST it
 * to /api/build/approve — the run waits until then, or until it times out):
 *   {"type":"approval_request","toolCallId":"...","toolName":"...","input":{...},"reason":"outbound","reasonText":"..."}
 *   {"type":"approval_resolved","toolCallId":"...","approved":true,"reason":"..."}
 *
 * If a provider failure restarts the run on a same-tier fallback model:
 *   {"type":"restart","fromModelKey":"...","toModelKey":"..."}   // discard steps received so far
 *
 * On error (validation or agent failure):
 *   {"type":"error","error":"...","code":"..."}
 *
 * The client reads the stream with a ReadableStream reader, parsing each
 * newline-delimited JSON line as it arrives. Every event carries a `seq`.
 *
 * The run is a job (lib/run-jobs.ts, lib/build-run.ts), not part of this
 * request: if the client disconnects, the run keeps going, and the client
 * can reconnect with GET /api/runs/:id/events (buffered events replay).
 * Stop it with POST /api/runs/:id/cancel (or the kill switch). The run
 * record is checkpointed as 'running' after every step; a run cut off by a
 * server restart is marked 'interrupted' and can be resumed from
 * /results/[id] (POST /api/runs/:id/resume).
 */

import { parseRolloutMode } from '@/lib/llm/approval-policy';
import { planFirstByDefault } from '@/lib/llm/planner';
import { AUTO_MODEL, routingEnabledByDefault } from '@/lib/llm/model-router';
import { getModelRegistry } from '@/lib/llm/model-registry';
import { checkInput } from '@/lib/llm/guardrails';
import { runsBlockedReason } from '@/lib/kill-switch';
import { streamJob } from '@/lib/run-jobs';
import { startBuildRun } from '@/lib/build-run';
import { ApiError, BuildRequest } from '@/lib/types';

// ── Validation helpers ────────────────────────────────────────────────────────

function validateRequest(body: unknown): { ok: true; req: BuildRequest } | { ok: false; error: ApiError; status: number } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: { error: 'Invalid JSON in request body', code: 'INVALID_JSON' }, status: 400 };
  }
  const b = body as Record<string, unknown>;

  if (!b.description || typeof b.description !== 'string') {
    return {
      ok: false,
      error: { error: 'Missing or invalid "description" field', code: 'VALIDATION_ERROR', details: { required: ['description'] } },
      status: 400,
    };
  }

  const rawDescription = b.description.trim();
  if (rawDescription.length < 10) {
    return {
      ok: false,
      error: { error: 'Description must be at least 10 characters', code: 'VALIDATION_ERROR', details: { minLength: 10, received: rawDescription.length } },
      status: 400,
    };
  }
  if (rawDescription.length > 5000) {
    return {
      ok: false,
      error: { error: 'Description must be less than 5000 characters', code: 'VALIDATION_ERROR', details: { maxLength: 5000, received: rawDescription.length } },
      status: 400,
    };
  }

  // Input guardrail: refuse credentials, apply INPUT_PII_MODE, flag override phrasing.
  const input = checkInput(rawDescription);
  if (!input.ok) {
    return { ok: false, error: { error: input.reason, code: input.code }, status: 400 };
  }
  if (input.injection.length) {
    console.warn('[BUILD] Request contains instruction-override phrasing:', input.injection);
  }
  const description = input.text;

  if (b.model !== undefined && b.model !== AUTO_MODEL) {
    const known = getModelRegistry().some((e) => e.key === b.model);
    if (!known) {
      return {
        ok: false,
        error: { error: `Unknown model "${b.model}"`, code: 'VALIDATION_ERROR', details: { available: getModelRegistry().map((e) => e.key) } },
        status: 400,
      };
    }
  }

  const MIN_TOOL = 4, MAX_TOOL = 80;
  if (b.toolShortlistSize !== undefined) {
    const v = b.toolShortlistSize;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_TOOL || v > MAX_TOOL) {
      return {
        ok: false,
        error: { error: `"toolShortlistSize" must be an integer between ${MIN_TOOL} and ${MAX_TOOL}`, code: 'VALIDATION_ERROR', details: { min: MIN_TOOL, max: MAX_TOOL } },
        status: 400,
      };
    }
  }

  const MIN_STEPS = 1, MAX_STEPS = 50;
  if (b.maxSteps !== undefined) {
    const v = b.maxSteps;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_STEPS || v > MAX_STEPS) {
      return {
        ok: false,
        error: { error: `"maxSteps" must be an integer between ${MIN_STEPS} and ${MAX_STEPS}`, code: 'VALIDATION_ERROR', details: { min: MIN_STEPS, max: MAX_STEPS } },
        status: 400,
      };
    }
  }

  const MIN_RETRIES = 0, MAX_RETRIES = 3;
  if (b.toolRetries !== undefined) {
    const v = b.toolRetries;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_RETRIES || v > MAX_RETRIES) {
      return {
        ok: false,
        error: { error: `"toolRetries" must be an integer between ${MIN_RETRIES} and ${MAX_RETRIES}`, code: 'VALIDATION_ERROR', details: { min: MIN_RETRIES, max: MAX_RETRIES } },
        status: 400,
      };
    }
  }

  const MIN_THINKING = 1024, MAX_THINKING = 64_000;
  if (b.thinkingBudget !== undefined) {
    const v = b.thinkingBudget;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_THINKING || v > MAX_THINKING) {
      return {
        ok: false,
        error: { error: `"thinkingBudget" must be an integer between ${MIN_THINKING} and ${MAX_THINKING}`, code: 'VALIDATION_ERROR', details: { min: MIN_THINKING, max: MAX_THINKING } },
        status: 400,
      };
    }
  }

  if (b.maxTokens !== undefined && (typeof b.maxTokens !== 'number' || !Number.isInteger(b.maxTokens) || b.maxTokens < 1_000)) {
    return {
      ok: false,
      error: { error: '"maxTokens" must be an integer of at least 1000', code: 'VALIDATION_ERROR', details: { min: 1_000 } },
      status: 400,
    };
  }
  if (b.maxCostUsd !== undefined && (typeof b.maxCostUsd !== 'number' || !(b.maxCostUsd > 0))) {
    return {
      ok: false,
      error: { error: '"maxCostUsd" must be a positive number', code: 'VALIDATION_ERROR' },
      status: 400,
    };
  }
  if (b.rolloutMode !== undefined && !parseRolloutMode(b.rolloutMode)) {
    return {
      ok: false,
      error: { error: '"rolloutMode" must be "autonomous", "assisted", or "shadow"', code: 'VALIDATION_ERROR' },
      status: 400,
    };
  }

  return {
    ok: true,
    req: {
      description,
      // "auto" routes per request (lib/llm/model-router.ts); MODEL_ROUTING=true makes it the default.
      model: typeof b.model === 'string' ? b.model : routingEnabledByDefault() ? AUTO_MODEL : undefined,
      toolRetries: typeof b.toolRetries === 'number' ? b.toolRetries : undefined,
      toolShortlistSize: typeof b.toolShortlistSize === 'number' ? b.toolShortlistSize : undefined,
      maxSteps: typeof b.maxSteps === 'number' ? b.maxSteps : undefined,
      maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
      maxCostUsd: typeof b.maxCostUsd === 'number' ? b.maxCostUsd : undefined,
      policy: b.policy === 'read-only' ? 'read-only' : b.policy === 'full' ? 'full' : undefined,
      dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : undefined,
      planFirst: typeof b.planFirst === 'boolean' ? b.planFirst : planFirstByDefault(),
      // A request can ask for plan approval; PLAN_APPROVAL=true requires it for every planned run.
      requirePlanApproval: b.requirePlanApproval === true || process.env.PLAN_APPROVAL?.trim().toLowerCase() === 'true',
      rolloutMode: parseRolloutMode(b.rolloutMode),
      thinkingBudget: typeof b.thinkingBudget === 'number' ? b.thinkingBudget : undefined,
    },
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
  }

  const blocked = runsBlockedReason();
  if (blocked) {
    return Response.json({ error: blocked, code: 'KILL_SWITCH' } as ApiError, { status: 503 });
  }

  const validation = validateRequest(body);
  if (!validation.ok) {
    return Response.json(validation.error, { status: validation.status });
  }
  const req = validation.req;

  return streamJob(startBuildRun(req, request.headers.get('x-harness-user') || 'anonymous'));
}
