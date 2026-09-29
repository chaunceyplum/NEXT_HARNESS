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
 * newline-delimited JSON line as it arrives. If the client disconnects (or
 * hits Stop), the agent run is aborted rather than left running tools.
 */

import { runAgent } from '@/lib/llm/agent';
import { waitForApproval } from '@/lib/llm/approvals';
import { APPROVAL_REASON_TEXT, parseRolloutMode } from '@/lib/llm/approval-policy';
import { getModelRegistry, getDefaultModelKey } from '@/lib/llm/model-registry';
import { newRunId, saveExecution } from '@/lib/execution-store';
import { checkInput, createStreamRedactor, redactOutput } from '@/lib/llm/guardrails';
import { registerRun, runsBlockedReason } from '@/lib/kill-switch';
import { auditReads, recordAudit, type AuditEvent } from '@/lib/audit-log';
import { ApiError, BuildRequest, BuildStreamEvent, ExecutionRecord } from '@/lib/types';

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
      model: typeof b.model === 'string' ? b.model : undefined,
      toolRetries: typeof b.toolRetries === 'number' ? b.toolRetries : undefined,
      toolShortlistSize: typeof b.toolShortlistSize === 'number' ? b.toolShortlistSize : undefined,
      maxSteps: typeof b.maxSteps === 'number' ? b.maxSteps : undefined,
      maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
      maxCostUsd: typeof b.maxCostUsd === 'number' ? b.maxCostUsd : undefined,
      policy: b.policy === 'read-only' ? 'read-only' : b.policy === 'full' ? 'full' : undefined,
      dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : undefined,
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

  console.log('[BUILD] Running agent for:', req.description.slice(0, 80));

  const runId = newRunId();
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();
  const actor = request.headers.get('x-harness-user') || 'anonymous';
  // Who started the run, persisted with it (server-set, never from the body).
  req.requestedBy = actor;
  void recordAudit([{ type: 'run_start', runId, actor, input: { description: req.description, model: req.model } }]);
  // Tool outcomes are buffered per step and written in one insert.
  let pendingAudit: AuditEvent[] = [];
  const flushAudit = () => {
    const batch = pendingAudit;
    pendingAudit = [];
    void recordAudit(batch);
  };

  // Aborts the agent run when the client goes away — the request's own signal
  // (disconnect) or the stream being cancelled (reader.cancel / Stop button).
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  // The kill switch aborts runs through this same controller.
  const unregister = registerRun(runId, {
    abort,
    startedAt,
    user: actor,
    description: req.description,
  });

  // TASK 8: Create a ReadableStream that pushes NDJSON events
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      // Writing to a stream the client has cancelled throws; after a
      // disconnect, events just have nowhere to go.
      const push = (event: BuildStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true;
        }
      };
      // Streamed tokens pass through the output guardrail too. A credential can
      // span several deltas, so text is held back until it's safe to redact.
      const textRedactor = createStreamRedactor();
      const pushDelta = (delta: string) => {
        if (delta) push({ type: 'text_delta', delta });
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed/cancelled */ }
      };

      try {
        // Emit run_start immediately so the client can show a run ID before
        // any steps. The tool list isn't known until tool selection resolves
        // inside runAgent, so it's sent on `done` instead.
        push({ type: 'run_start', runId, toolsConsidered: [] });

        const rawResult = await runAgent({
          userInput: req.description,
          modelKey: req.model,
          toolRetries: req.toolRetries,
          toolShortlistSize: req.toolShortlistSize,
          maxSteps: req.maxSteps,
          budget: { maxTokens: req.maxTokens, maxCostUsd: req.maxCostUsd },
          policy: req.policy,
          dryRun: req.dryRun,
          rolloutMode: req.rolloutMode,
          thinkingBudget: req.thinkingBudget,
          abortSignal: abort.signal,
          // TASK 8: stream each step as it completes
          onStep: (step) => {
            pushDelta(textRedactor.flush());
            push({ type: 'step', step: redactOutput(step) });
            flushAudit();
          },
          // Audit log: every write/destructive call's outcome (reads with AUDIT_READS=true)
          onToolOutcome: (o) => {
            if (o.level === 'read' && !o.approvalReason && !auditReads()) return;
            pendingAudit.push({
              type: 'tool_call',
              runId,
              actor,
              tool: o.toolName,
              level: o.level,
              reason: o.approvalReason,
              input: o.input,
              outcome: o.outcome,
              error: o.error,
            });
          },
          // TASK 1: stream assistant text token-by-token as it's generated
          onTextDelta: (delta) => pushDelta(textRedactor.push(delta)),
          onRestart: ({ fromModelKey, toModelKey }) => push({ type: 'restart', fromModelKey, toModelKey }),
          // TASK 9: flagged calls wait here for the user's decision
          approveTool: async ({ toolCallId, toolName, input, reason }) => {
            push({ type: 'approval_request', toolCallId, toolName, input: redactOutput(input), reason, reasonText: APPROVAL_REASON_TEXT[reason] });
            const decision = await waitForApproval(runId, toolCallId, abort.signal);
            push({ type: 'approval_resolved', toolCallId, approved: decision.approved, reason: decision.reason });
            void recordAudit([
              {
                type: 'approval',
                runId,
                // Who decided; timeouts and cancellations are the system's call.
                actor: decision.decidedBy ?? 'system',
                tool: toolName,
                reason,
                input,
                outcome: decision.approved ? 'approved' : 'denied',
                error: decision.approved ? undefined : decision.reason,
              },
            ]);
            return decision;
          },
        });

        // Output guardrail: nothing leaves the server (stream or run history) unredacted.
        const agentResult = redactOutput(rawResult);

        console.log('[BUILD] Agent finished:', {
          runId,
          steps: agentResult.steps.length,
          finishReason: agentResult.finishReason,
          usage: agentResult.usage,
        });

        pushDelta(textRedactor.flush());
        push({
          type: 'done',
          finalText: agentResult.finalText,
          finishReason: agentResult.finishReason,
          usage: agentResult.usage,
          runId,
          modelKey: agentResult.modelKey,
          toolsConsidered: agentResult.toolsConsidered,
          stopReason: agentResult.stopReason,
          budgetUsage: agentResult.budgetUsage,
        });

        close();

        // Persist after streaming so we don't delay the response
        const completedRecord: ExecutionRecord = {
          id: runId,
          createdAt,
          description: req.description,
          model: agentResult.modelKey,
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
            stopReason: agentResult.stopReason,
            budgetUsage: agentResult.budgetUsage,
            ragJudgments: agentResult.ragJudgments,
          },
        };
        saveExecution(completedRecord).catch((err) => console.error('[BUILD] Failed to persist completed run:', err));
      } catch (error) {
        const cancelled = abort.signal.aborted;
        const abortReason = abort.signal.reason instanceof Error ? abort.signal.reason.message : undefined;
        const message = redactOutput(
          cancelled
            ? abortReason?.startsWith('Stopped by the kill switch') ? abortReason : 'Cancelled by client'
            : error instanceof Error ? error.message : String(error),
        );
        if (cancelled) console.log('[BUILD] Agent run cancelled by client:', runId);
        else console.error('[BUILD] Agent run failed:', error);

        push({ type: 'error', error: `Agent run failed: ${message}`, code: cancelled ? 'CANCELLED' : 'AGENT_ERROR' });
        close();

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
      } finally {
        flushAudit();
        unregister();
      }
    },
    cancel() {
      abort.abort();
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
