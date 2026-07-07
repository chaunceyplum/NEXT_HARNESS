/**
 * Execution Runner
 *
 * Runs a PlannedStep[] sequentially against the real MCP tools via
 * callMcpTool(), resolving cross-step argument references, and recording
 * progress into the execution store as it goes.
 *
 * This is intentionally simple and sequential (no parallelism, no retries)
 * to keep behavior predictable and easy to reason about from the UI. A
 * non-critical step failing does not stop the run; a critical step failing
 * aborts remaining steps (they are marked 'skipped').
 *
 * OBSERVABILITY: every meaningful thing the runner does is traced via
 * lib/observability.ts — lifecycle transitions, each step's start/outcome,
 * ref-resolution failures, and one structured invocation record per real
 * MCP tool call (with timing, arg/output previews, and errors). See that
 * module for the trace/invocation shapes.
 */

import { callMcpTool } from './mcp-client';
import { PlannedStep, resolveRef } from './plan-builder';
import { updateStep, setExecutionStatus, getExecution } from './execution-store';
import { createTracer, summarizeValue } from './observability';

export async function runPlan(executionId: string, steps: PlannedStep[]): Promise<void> {
  const results: Record<string, any> = {};
  let hadNonCriticalFailure = false;

  const tracer = createTracer(executionId);
  const runStartedAt = Date.now();
  tracer.event('execution.started', `Execution started with ${steps.length} step(s).`, {
    data: { stepCount: steps.length },
  });

  for (const step of steps) {
    const record = getExecution(executionId);
    if (!record) return; // execution vanished (shouldn't happen)

    const stepStart = Date.now();
    updateStep(executionId, step.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    tracer.event('step.started', `Step started: ${step.label}`, {
      stepId: step.id,
      tool: step.tool,
      category: step.category,
      data: { critical: step.critical },
    });

    // Resolve dynamic args from prior step results
    const resolvedArgs: Record<string, any> = { ...step.args };
    let refResolutionFailed = false;

    if (step.refs) {
      for (const [argName, ref] of Object.entries(step.refs)) {
        const value = resolveRef(ref, results);
        if (value === undefined) {
          refResolutionFailed = true;
          const message = `Could not resolve required input "${argName}" from "${ref}" — a dependency step did not return the expected field.`;
          updateStep(executionId, step.id, {
            status: 'failed',
            error: message,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
          });
          tracer.event('step.ref_resolution_failed', `Step "${step.label}" could not resolve input "${argName}".`, {
            level: 'error',
            stepId: step.id,
            tool: step.tool,
            category: step.category,
            durationMs: Date.now() - stepStart,
            data: { argName, ref },
          });
          break;
        }
        resolvedArgs[argName] = value;
      }
    }

    // Resolve dynamic *array* refs — unlike step.refs, individual entries
    // that fail to resolve (e.g. an optional upstream step failed/skipped)
    // are silently dropped rather than failing the whole step. This lets
    // "bundle whatever succeeded" calls (e.g. adding rules/data elements to
    // a Launch library) proceed with a partial set instead of aborting.
    if (!refResolutionFailed && step.listRefs) {
      for (const [argName, refs] of Object.entries(step.listRefs)) {
        const resolved = refs
          .map((ref) => resolveRef(ref, results))
          .filter((v) => v !== undefined);
        resolvedArgs[argName] = resolved;
        if (resolved.length < refs.length) {
          tracer.event(
            'step.started',
            `Step "${step.label}" bundling partial list "${argName}" (${resolved.length}/${refs.length} resolved).`,
            {
              level: 'warn',
              stepId: step.id,
              tool: step.tool,
              category: step.category,
              data: { argName, resolved: resolved.length, requested: refs.length },
            }
          );
        }
      }
    }

    if (refResolutionFailed) {
      if (step.critical) {
        skipRemaining(executionId, steps, step.id, tracer);
        setExecutionStatus(
          executionId,
          'failed',
          `Critical step "${step.label}" could not run because a dependency's output was missing.`
        );
        tracer.event('execution.finished', `Execution failed at critical step "${step.label}" (missing dependency output).`, {
          level: 'error',
          durationMs: Date.now() - runStartedAt,
          data: { status: 'failed' },
        });
        return;
      }
      hadNonCriticalFailure = true;
      continue;
    }

    // Invoke the real MCP tool, recording an invocation record either way.
    const argsSummary = summarizeValue(resolvedArgs);
    tracer.event('step.tool_invoked', `Invoking tool ${step.tool}`, {
      level: 'debug',
      stepId: step.id,
      tool: step.tool,
      category: step.category,
      data: { argsBytes: argsSummary.bytes },
    });

    const invokeStart = Date.now();
    const invokeStartedAt = new Date().toISOString();
    try {
      const result = await callMcpTool(step.tool, resolvedArgs);
      const durationMs = Date.now() - invokeStart;
      results[step.id] = result;

      const outputSummary = summarizeValue(result);
      updateStep(executionId, step.id, {
        status: 'completed',
        result,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStart,
      });
      tracer.invocation({
        stepId: step.id,
        tool: step.tool,
        category: step.category,
        status: 'success',
        argsPreview: argsSummary.preview,
        outputPreview: outputSummary.preview,
        outputBytes: outputSummary.bytes,
        durationMs,
        startedAt: invokeStartedAt,
        completedAt: new Date().toISOString(),
      });
      tracer.event('step.succeeded', `Step succeeded: ${step.label}`, {
        stepId: step.id,
        tool: step.tool,
        category: step.category,
        durationMs,
        data: { outputBytes: outputSummary.bytes },
      });
    } catch (error) {
      const durationMs = Date.now() - invokeStart;
      const message = error instanceof Error ? error.message : String(error);
      updateStep(executionId, step.id, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStart,
      });
      tracer.invocation({
        stepId: step.id,
        tool: step.tool,
        category: step.category,
        status: 'error',
        argsPreview: argsSummary.preview,
        error: message,
        durationMs,
        startedAt: invokeStartedAt,
        completedAt: new Date().toISOString(),
      });
      tracer.event('step.failed', `Step failed: ${step.label} — ${message}`, {
        level: 'error',
        stepId: step.id,
        tool: step.tool,
        category: step.category,
        durationMs,
        data: { critical: step.critical },
      });

      if (step.critical) {
        skipRemaining(executionId, steps, step.id, tracer);
        setExecutionStatus(
          executionId,
          'failed',
          `Critical step "${step.label}" failed: ${message}`
        );
        tracer.event('execution.finished', `Execution failed at critical step "${step.label}".`, {
          level: 'error',
          durationMs: Date.now() - runStartedAt,
          data: { status: 'failed' },
        });
        return;
      }
      hadNonCriticalFailure = true;
    }
  }

  const finalStatus = hadNonCriticalFailure ? 'completed_with_errors' : 'completed';
  setExecutionStatus(executionId, finalStatus);
  tracer.event('execution.finished', `Execution ${finalStatus.replace(/_/g, ' ')}.`, {
    level: hadNonCriticalFailure ? 'warn' : 'info',
    durationMs: Date.now() - runStartedAt,
    data: { status: finalStatus },
  });
}

function skipRemaining(
  executionId: string,
  steps: PlannedStep[],
  failedStepId: string,
  tracer: ReturnType<typeof createTracer>
): void {
  const failedIndex = steps.findIndex((s) => s.id === failedStepId);
  for (let i = failedIndex + 1; i < steps.length; i++) {
    updateStep(executionId, steps[i].id, { status: 'skipped' });
    tracer.event('step.skipped', `Step skipped (aborted after critical failure): ${steps[i].label}`, {
      level: 'warn',
      stepId: steps[i].id,
      tool: steps[i].tool,
      category: steps[i].category,
    });
  }
}
