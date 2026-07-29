/**
 * Shared "validate a build request, then start a Step Functions run" logic
 * — used by both POST /api/build and POST /api/tickets so validation and
 * the StartExecution call only exist in one place. A ticket is just a
 * BuildRequest plus metadata (lib/types.ts's Ticket); submitting one goes
 * through this exact same launch path.
 */

import { newRunId } from './execution-store';
import { getDefaultModelKey, getModelRegistry } from './llm/model-registry';
import { startRun } from './step-functions-client';
import type { ApiError, BuildRequest } from './types';

export interface LaunchValidationError {
  response: ApiError;
  status: number;
}

/** Returns a validation error to return as-is, or null if `body` is launchable. */
export function validateLaunchInput(body: Partial<BuildRequest>): LaunchValidationError | null {
  if (!body.description || typeof body.description !== 'string') {
    return {
      status: 400,
      response: {
        error: 'Missing or invalid "description" field',
        code: 'VALIDATION_ERROR',
        details: { required: ['description'] },
      },
    };
  }

  const description = body.description.trim();
  if (description.length < 10) {
    return {
      status: 400,
      response: {
        error: 'Description must be at least 10 characters',
        code: 'VALIDATION_ERROR',
        details: { minLength: 10, received: description.length },
      },
    };
  }
  if (description.length > 5000) {
    return {
      status: 400,
      response: {
        error: 'Description must be less than 5000 characters',
        code: 'VALIDATION_ERROR',
        details: { maxLength: 5000, received: description.length },
      },
    };
  }

  if (body.model) {
    const known = getModelRegistry().some((entry) => entry.key === body.model);
    if (!known) {
      return {
        status: 400,
        response: {
          error: `Unknown model "${body.model}"`,
          code: 'VALIDATION_ERROR',
          details: { available: getModelRegistry().map((entry) => entry.key) },
        },
      };
    }
  }

  return null;
}

export interface LaunchRunResult {
  runId: string;
}

/** Assumes `body` has already passed validateLaunchInput. Starts a Step Functions execution and returns its runId. */
export async function launchRun(body: BuildRequest): Promise<LaunchRunResult> {
  const runId = newRunId();
  const modelKey = body.model || getDefaultModelKey();

  await startRun({
    runId,
    description: body.description.trim(),
    modelKey,
    allowFullBuild: body.allowFullBuild === true,
    autonomous: body.autonomous === true,
    maxSteps: body.maxSteps ?? 10,
    toolShortlistSize: body.toolShortlistSize ?? 12,
    toolRetries: body.toolRetries ?? 1,
  });

  return { runId };
}
