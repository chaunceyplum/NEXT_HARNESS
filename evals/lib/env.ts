/**
 * What an eval file needs configured before it's worth running, so a suite
 * with nothing configured skips itself with a clear reason instead of
 * failing every fixture on the same missing credential.
 */

import { getDefaultModelKey, getModelEntry } from '@/lib/llm/model-registry';

/** Model under test for the agent suite. EVAL_MODEL overrides DEFAULT_MODEL, so two models can be compared on the same fixtures. */
export function evalModelKey(): string {
  return process.env.EVAL_MODEL || getDefaultModelKey();
}

/** Model that grades rubric questions. Defaults to DEFAULT_MODEL rather than EVAL_MODEL, so an A/B run across models keeps a constant grader. */
export function judgeModelKey(): string {
  return process.env.EVAL_JUDGE_MODEL || getDefaultModelKey();
}

export function isMcpConfigured(): boolean {
  return Boolean(process.env.MCP_ENDPOINT_URL);
}

/**
 * Best-effort "are this model's provider credentials present" check. Not a
 * guarantee the call will succeed (Bedrock model access, for one, is
 * granted per model outside IAM) — just enough to tell "nothing configured"
 * apart from "configured, but failing", which the fixtures themselves report.
 */
export function isModelConfigured(modelKey: string): boolean {
  let provider: string;
  try {
    provider = getModelEntry(modelKey).provider;
  } catch {
    return false;
  }
  const env = process.env;
  switch (provider) {
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY);
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    case 'bedrock':
      return Boolean(
        env.AWS_BEARER_TOKEN_BEDROCK ||
          (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
          env.AWS_PROFILE ||
          env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
          env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
          env.AWS_WEB_IDENTITY_TOKEN_FILE
      );
    default:
      return false;
  }
}

/** Print once per file why a suite is being skipped, since describe.skipIf alone says nothing. */
export function warnSkip(suite: string, reason: string): void {
  console.warn(`[evals] Skipping ${suite}: ${reason}`);
}
