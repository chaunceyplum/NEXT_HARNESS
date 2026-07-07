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
 */

import { callMcpTool } from './mcp-client';
import { PlannedStep, resolveRef } from './plan-builder';
import { updateStep, setExecutionStatus, getExecution } from './execution-store';

export async function runPlan(executionId: string, steps: PlannedStep[]): Promise<void> {
  const results: Record<string, any> = {};
  let hadNonCriticalFailure = false;

  for (const step of steps) {
    const record = getExecution(executionId);
    if (!record) return; // execution vanished (shouldn't happen)

    updateStep(executionId, step.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    // Resolve dynamic args from prior step results
    const resolvedArgs: Record<string, any> = { ...step.args };
    let refResolutionFailed = false;

    if (step.refs) {
      for (const [argName, ref] of Object.entries(step.refs)) {
        const value = resolveRef(ref, results);
        if (value === undefined) {
          refResolutionFailed = true;
          updateStep(executionId, step.id, {
            status: 'failed',
            error: `Could not resolve required input "${argName}" from "${ref}" — a dependency step did not return the expected field.`,
            completedAt: new Date().toISOString(),
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
      }
    }

    if (refResolutionFailed) {
      if (step.critical) {
        skipRemaining(executionId, steps, step.id);
        setExecutionStatus(
          executionId,
          'failed',
          `Critical step "${step.label}" could not run because a dependency's output was missing.`
        );
        return;
      }
      hadNonCriticalFailure = true;
      continue;
    }

    try {
      const result = await callMcpTool(step.tool, resolvedArgs);
      results[step.id] = result;
      updateStep(executionId, step.id, {
        status: 'completed',
        result,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStep(executionId, step.id, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      });

      if (step.critical) {
        skipRemaining(executionId, steps, step.id);
        setExecutionStatus(
          executionId,
          'failed',
          `Critical step "${step.label}" failed: ${message}`
        );
        return;
      }
      hadNonCriticalFailure = true;
    }
  }

  setExecutionStatus(executionId, hadNonCriticalFailure ? 'completed_with_errors' : 'completed');
}

function skipRemaining(executionId: string, steps: PlannedStep[], failedStepId: string): void {
  const failedIndex = steps.findIndex((s) => s.id === failedStepId);
  for (let i = failedIndex + 1; i < steps.length; i++) {
    updateStep(executionId, steps[i].id, { status: 'skipped' });
  }
}
