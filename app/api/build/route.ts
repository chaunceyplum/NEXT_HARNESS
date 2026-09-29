/**
 * POST /api/build
 *
 * TASK 8: Streaming response. Instead of blocking until the full agent run
 * completes, this route returns a streaming response of newline-delimited JSON
 * (NDJSON) events so the client can render each step as it arrives.
 *
 * Event sequence:
 *   {"type":"run_start","runId":"...","toolsConsidered":["..."]}
 *   {"type":"step","step":{...}}           // one per agent step, as it finishes
 *   {"type":"step","step":{...}}
 *   ...
 *   {"type":"done","finalText":"...","finishReason":"stop","usage":{...},"runId":"..."}
 *
 * On error (validation or agent failure):
 *   {"type":"error","error":"...","code":"..."}
 *
 * The client reads the stream with a ReadableStream reader, parsing each
 * newline-delimited JSON line as it arrives.
 */

import { runAgent } from '@/lib/llm/agent';
import { getModelRegistry, getDefaultModelKey } from '@/lib/llm/model-registry';
import { newRunId, saveExecution } from '@/lib/execution-store';
import { ApiError, BuildRequest, BuildResponse, BuildStreamEvent, ExecutionRecord } from '@/lib/types';

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

  const description = b.description.trim();
  if (description.length < 10) {
    return {
      ok: false,
      error: { error: 'Description must be at least 10 characters', code: 'VALIDATION_ERROR', details: { minLength: 10, received: description.length } },
      status: 400,
    };
  }
  if (description.length > 5000) {
    return {
      ok: false,
      error: { error: 'Description must be less than 5000 characters', code: 'VALIDATION_ERROR', details: { maxLength: 5000, received: description.length } },
      status: 400,
    };
  }

  if (b.model !== undefined) {
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

  return {
    ok: true,
    req: {
      description,
      model: typeof b.model === 'string' ? b.model : undefined,
      toolRetries: typeof b.toolRetries === 'number' ? b.toolRetries : undefined,
      toolShortlistSize: typeof b.toolShortlistSize === 'number' ? b.toolShortlistSize : undefined,
      maxSteps: typeof b.maxSteps === 'number' ? b.maxSteps : undefined,
      policy: b.policy === 'read-only' ? 'read-only' : b.policy === 'full' ? 'full' : undefined,
      dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : undefined,
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

  const validation = validateRequest(body);
  if (!validation.ok) {
    return Response.json(validation.error, { status: validation.status });
  }
  const req = validation.req;

  console.log('[BUILD] Running agent for:', req.description.slice(0, 80));

  const runId = newRunId();
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();

  // Collect steps for persistence — the stream writes them to the client
  // in real-time; we accumulate here so we can saveExecution at the end.
  const collectedSteps: BuildResponse['steps'] = [];

  // TASK 8: Create a ReadableStream that pushes NDJSON events
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (event: BuildStreamEvent) => {
        controller.enqueue(enc.encode(JSON.stringify(event) + '\n'));
      };

      try {
        // Emit run_start immediately so the client can show a run ID before any steps
        // We emit toolsConsidered later in done — placeholder empty for now; the client
        // will update it. (We don't have the list until selectLiveTools resolves.)
        push({ type: 'run_start', runId, toolsConsidered: [] });

        const agentResult = await runAgent({
          userInput: req.description,
          modelKey: req.model,
          toolRetries: req.toolRetries,
          toolShortlistSize: req.toolShortlistSize,
          maxSteps: req.maxSteps,
          policy: req.policy,
          dryRun: req.dryRun,
          thinkingBudget: req.thinkingBudget,
          // TASK 8: stream each step as it completes
          onStep: (step) => {
            collectedSteps.push(step);
            push({ type: 'step', step });
          },
        });

        console.log('[BUILD] Agent finished:', {
          runId,
          steps: agentResult.steps.length,
          finishReason: agentResult.finishReason,
          usage: agentResult.usage,
        });

        push({
          type: 'done',
          finalText: agentResult.finalText,
          finishReason: agentResult.finishReason,
          usage: agentResult.usage,
          runId,
        });

        controller.close();

        // Persist after streaming so we don't delay the response
        const completedRecord: ExecutionRecord = {
          id: runId,
          createdAt,
          description: req.description,
          model: req.model || getDefaultModelKey(),
          allowFullBuild: false,
          status: 'completed',
          durationMs: Date.now() - startedAt,
          toolsConsidered: agentResult.toolsConsidered,
          request: req,
          result: {
            runId,
            finalText: agentResult.finalText,
            steps: agentResult.steps,
            toolsConsidered: agentResult.toolsConsidered,
            finishReason: agentResult.finishReason,
            usage: agentResult.usage,
          },
        };
        saveExecution(completedRecord).catch((err) => console.error('[BUILD] Failed to persist completed run:', err));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[BUILD] Agent run failed:', error);

        push({ type: 'error', error: `Agent run failed: ${message}`, code: 'AGENT_ERROR' });
        controller.close();

        const failedRecord: ExecutionRecord = {
          id: runId,
          createdAt,
          description: req.description,
          model: req.model || getDefaultModelKey(),
          allowFullBuild: false,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          request: req,
          error: message,
        };
        saveExecution(failedRecord).catch((err) => console.error('[BUILD] Failed to persist failed run:', err));
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      // Allow the client to read the stream cross-origin if needed
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
