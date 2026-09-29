/**
 * What an eval file needs configured before it's worth running, so a suite
 * with nothing configured skips itself with a clear reason instead of
 * failing every fixture on the same missing credential.
 */

import { getDefaultModelKey, getModelEntry, getModelRegistry } from '@/lib/llm/model-registry';

/** Model under test for the agent suite. EVAL_MODEL overrides DEFAULT_MODEL, so two models can be compared on the same fixtures. */
export function evalModelKey(): string {
  return process.env.EVAL_MODEL || getDefaultModelKey();
}

/**
 * Model that grades rubric questions. EVAL_JUDGE_MODEL wins; otherwise the
 * most capable ("expensive") tier of the default model's provider, since a
 * judge should be at least as strong as what it grades. Independent of
 * EVAL_MODEL, so an A/B run across models keeps a constant grader.
 */
export function judgeModelKey(): string {
  if (process.env.EVAL_JUDGE_MODEL) return process.env.EVAL_JUDGE_MODEL;
  const defaultKey = getDefaultModelKey();
  try {
    const provider = getModelEntry(defaultKey).provider;
    const strongest = getModelRegistry().find((e) => e.provider === provider && e.tier === 'expensive');
    return strongest?.key ?? defaultKey;
  } catch {
    return defaultKey;
  }
}

/** A judge grading its own output favors it; say so rather than silently reporting an inflated score. */
export function warnIfSelfJudging(modelUnderTest: string, judge: string): void {
  if (modelUnderTest === judge) {
    console.warn(
      `[evals] The judge (${judge}) is the model under test, which biases rubric grades toward its own output. ` +
        'Set EVAL_JUDGE_MODEL to a different, stronger model.'
    );
  }
}

/** Trials per fixture (EVAL_TRIALS, default 1, capped at 20). One run says little about a non-deterministic agent. */
export function trialsPerFixture(): number {
  const n = Number(process.env.EVAL_TRIALS);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 20);
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
