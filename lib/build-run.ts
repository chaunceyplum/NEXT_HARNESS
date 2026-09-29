/**
 * Starting an agent run as a job (lib/run-jobs.ts), shared by POST
 * /api/build and POST /api/runs/:id/resume. The request has already been
 * validated; this owns everything after: kill-switch registration, the
 * agent loop, streaming events, per-step checkpoints, and the final record.
 */

import { runAgent } from '@/lib/llm/agent';
import { waitForApproval } from '@/lib/llm/approvals';
import { APPROVAL_REASON_TEXT } from '@/lib/llm/approval-policy';
import { getDefaultModelKey } from '@/lib/llm/model-registry';
import { CHECKPOINT_SCHEMA_VERSION, newRunId, saveExecution } from '@/lib/execution-store';
import { createStreamRedactor, redactOutput } from '@/lib/llm/guardrails';
import { judgeRun, shouldJudgeRun } from '@/lib/online-judge';
import { auditReads, recordAudit, type AuditEvent } from '@/lib/audit-log';
import { registerRun } from '@/lib/kill-switch';
import { startJob, type RunJob } from '@/lib/run-jobs';
import type { AgentStepDTO, BuildRequest, ExecutionRecord } from '@/lib/types';

export function startBuildRun(req: BuildRequest, actor: string): RunJob {
  console.log('[BUILD] Running agent for:', req.description.slice(0, 80));

  const runId = newRunId();
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();

  // The run is a job (lib/run-jobs.ts): it keeps going if this request's
  // client disconnects, and is stopped only by POST /api/runs/:id/cancel,
  // the kill switch (through this same controller), or its own limits.
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

  const abort = new AbortController();
  const unregister = registerRun(runId, {
    abort,
    startedAt,
    user: actor,
    description: req.description,
  });

  const job = startJob(runId, abort, async (push) => {
    // Checkpoints: the run record is saved as 'running' after every step,
    // so a crash or restart leaves the steps so far (marked 'interrupted' on
    // the next start, and resumable). Saves are chained so the last write wins.
    const steps: AgentStepDTO[] = [];
    // Streamed tokens pass through the output guardrail too. A credential can
    // span several deltas, so text is held back until it's safe to redact.
    const textRedactor = createStreamRedactor();
    const pushDelta = (delta: string) => {
      if (delta) push({ type: 'text_delta', delta });
    };
    let saving: Promise<void> = Promise.resolve();
    const save = (record: ExecutionRecord) => {
      saving = saving
        .then(() => saveExecution(record))
        .catch((err) => console.error(`[BUILD] Failed to save run ${runId} (${record.status}):`, err));
    };
    const checkpoint = () =>
      save({
        id: runId,
        createdAt,
        description: req.description,
        model: req.model || getDefaultModelKey(),
        allowFullBuild: false,
        status: 'running',
        durationMs: Date.now() - startedAt,
        request: req,
        result: {
          runId,
          finalText: '',
          steps: [...steps],
          toolsConsidered: [],
          finishReason: 'running',
          usage: {},
          checkpoint: { schemaVersion: CHECKPOINT_SCHEMA_VERSION, step: steps.length, savedAt: new Date().toISOString() },
        },
      });

    try {
      // Emit run_start immediately so the client can show a run ID before
      // any steps. The tool list isn't known until tool selection resolves
      // inside runAgent, so it's sent on `done` instead.
      push({ type: 'run_start', runId, toolsConsidered: [] });
      checkpoint();

      const rawResult = await runAgent({
        userInput: req.resumeContext ? `${req.description}\n\n${req.resumeContext}` : req.description,
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
        // TASK 8: stream each step as it completes, and checkpoint it
        onStep: (step) => {
          pushDelta(textRedactor.flush());
          const redacted = redactOutput(step);
          steps.push(redacted);
          push({ type: 'step', step: redacted });
          checkpoint();
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
        // TASK 1: stream assistant text token-by-token, through the output guardrail
        onTextDelta: (delta) => pushDelta(textRedactor.push(delta)),
        onRestart: ({ fromModelKey, toModelKey }) => {
          steps.length = 0;
          push({ type: 'restart', fromModelKey, toModelKey });
        },
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

      save({
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
      });
      // Online eval: grade a sample of real runs with the eval rubric judge, off the request path.
      if (shouldJudgeRun()) {
        void saving.then(() => judgeRun({ runId, task: req.description, answer: agentResult.finalText, steps: agentResult.steps }));
      }
    } catch (error) {
      const cancelled = abort.signal.aborted;
      const abortReason = abort.signal.reason instanceof Error ? abort.signal.reason.message : undefined;
      const message = redactOutput(
        cancelled ? (abortReason ?? 'Cancelled') : error instanceof Error ? error.message : String(error)
      );
      if (cancelled) console.log(`[BUILD] Agent run ${runId} stopped: ${message}`);
      else console.error('[BUILD] Agent run failed:', error);

      push({ type: 'error', error: `Agent run failed: ${message}`, code: cancelled ? 'CANCELLED' : 'AGENT_ERROR' });

      save({
        id: runId,
        createdAt,
        description: req.description,
        model: req.model || getDefaultModelKey(),
        allowFullBuild: false,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        request: req,
        // Keep the checkpointed steps: they show what ran before the failure.
        ...(steps.length
          ? { result: { runId, finalText: '', steps, toolsConsidered: [], finishReason: 'error', usage: {} } }
          : {}),
        error: message,
      });
    } finally {
      flushAudit();
      unregister();
      await saving;
    }
  });

  return job;
}

const MAX_RESUME_CHARS = 6_000;

/**
 * What an interrupted run already did, for the run that resumes it: every
 * tool call and its outcome, capped. The new run sees it after the original
 * request, with instructions not to redo completed changes. Continuation is
 * by context, not by replaying the model's exact message history.
 */
export function resumeContextFrom(record: ExecutionRecord): string {
  const lines: string[] = [];
  for (const step of record.result?.steps ?? []) {
    step.toolCalls.forEach((call, i) => {
      const res = step.toolResults[i];
      const outcome = !res ? 'no result recorded' : res.error ? `ERROR: ${res.error}` : `OK: ${JSON.stringify(res.output ?? null)}`;
      lines.push(`- ${call.toolName} ${JSON.stringify(call.input)} → ${outcome.slice(0, 400)}`);
    });
  }
  let history = lines.join('\n');
  if (history.length > MAX_RESUME_CHARS) history = `${history.slice(0, MAX_RESUME_CHARS)}\n… (truncated)`;
  return [
    `This request was started before (run ${record.id}) and was interrupted after ${record.result?.steps.length ?? 0} step(s).`,
    history ? `Tool calls it already made:\n${history}` : 'It had not made any tool calls yet.',
    'Continue from where it stopped. Do not repeat changes that already succeeded; if you are unsure whether one took effect, check with a read tool first. In your final answer, cover the whole request, including what the earlier attempt did.',
  ].join('\n\n');
}
