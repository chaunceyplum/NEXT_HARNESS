/**
 * What an eval file needs configured, which models it grades with, and
 * where each choice came from — so a misconfiguration shows up as one clear
 * line before any fixture runs, not as dozens of identical failures.
 */

import { generateText } from 'ai';
import { getDefaultModelKey, getModelEntry, getModelRegistry, resolveModel } from '@/lib/llm/model-registry';

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

/**
 * Judge to retry on when the primary judge refuses: EVAL_JUDGE_FALLBACK_MODEL,
 * else the next-strongest model on the same provider (expensive tier first,
 * then balanced). Refusals are model-specific, so a sibling usually grades
 * what the primary won't.
 */
export function judgeFallbackModelKey(primary: string): string | undefined {
  if (process.env.EVAL_JUDGE_FALLBACK_MODEL) return process.env.EVAL_JUDGE_FALLBACK_MODEL;
  try {
    const { provider } = getModelEntry(primary);
    const siblings = getModelRegistry().filter((e) => e.provider === provider && e.key !== primary);
    return (siblings.find((e) => e.tier === 'expensive') ?? siblings.find((e) => e.tier === 'balanced'))?.key;
  } catch {
    return undefined;
  }
}

/** Where a role's model key came from, for the config line each suite prints. */
export function modelSource(role: 'model' | 'judge' | 'rag-judge'): string {
  const fromDefault = process.env.DEFAULT_MODEL ? 'DEFAULT_MODEL' : "built-in default (DEFAULT_MODEL unset)";
  if (role === 'model') return process.env.EVAL_MODEL ? 'EVAL_MODEL' : fromDefault;
  if (role === 'rag-judge') return process.env.RAG_JUDGE_MODEL ? 'RAG_JUDGE_MODEL' : fromDefault;
  return process.env.EVAL_JUDGE_MODEL ? 'EVAL_JUDGE_MODEL' : `strongest tier of ${fromDefault}'s provider`;
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
 * Values copied from .env.local.example without being filled in ("...",
 * "<api-gateway-key>", "sk-ant-...") — set, but not a credential.
 */
export function isPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return v.includes('...') || /^<.*>$/.test(v) || /^(your[-_]|changeme|xxx|todo)/i.test(v);
}

function hasCredential(value: string | undefined): boolean {
  return Boolean(value) && !isPlaceholder(value);
}

/**
 * "Nothing configured for this model's provider" — the suite should skip,
 * not fail. Not a guarantee a call will succeed; preflight() checks that.
 *
 * Bedrock counts as configured unless explicit keys are placeholders: the
 * AWS SDK's default credential chain also covers an EC2 instance role,
 * ECS/EKS task roles and SSO, none of which show up as env vars.
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
      return hasCredential(env.ANTHROPIC_API_KEY);
    case 'openai':
      return hasCredential(env.OPENAI_API_KEY);
    case 'bedrock':
      return !isPlaceholder(env.AWS_ACCESS_KEY_ID) && !isPlaceholder(env.AWS_SECRET_ACCESS_KEY);
    default:
      return false;
  }
}

/**
 * Say once per file why a suite is being skipped, since describe.skipIf
 * alone says nothing. Written straight to stderr: vitest drops console output
 * from a file whose tests were all skipped, which is exactly this case.
 */
export function warnSkip(suite: string, reason: string): void {
  process.stderr.write(`[evals] Skipping ${suite}: ${reason}\n`);
}

const CREDENTIAL_HINT: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  bedrock: 'real AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or remove them to use an instance role)',
};

export interface ModelRole {
  /** Shown in messages, e.g. "model under test", "judge". */
  role: string;
  key: string;
  source: string;
}

export type PreflightResult =
  | { status: 'ready' }
  /** Nothing configured — skip quietly, as before. */
  | { status: 'skip'; reason: string }
  /** Configured but failing — fail once, loudly, and record nothing. */
  | { status: 'fail'; reason: string };

/**
 * One tiny real call per distinct model a suite needs, before any fixture
 * runs. A bad key, an unknown model id, or a model the account can't use
 * then shows up as one line naming the setting to fix — instead of every
 * fixture × trial failing identically and a 0% run being saved to /evals.
 */
export async function preflight(suite: string, roles: ModelRole[]): Promise<PreflightResult> {
  process.stderr.write(`[evals] ${suite}: ${roles.map((r) => `${r.role} ${r.key} (from ${r.source})`).join('; ')}\n`);

  for (const r of roles) {
    try {
      getModelEntry(r.key);
    } catch (err) {
      return { status: 'fail', reason: `${r.role} "${r.key}" (from ${r.source}): ${(err as Error).message}` };
    }
    if (!isModelConfigured(r.key)) {
      const provider = getModelEntry(r.key).provider;
      const credential = CREDENTIAL_HINT[provider] ?? `${provider} credentials`;
      return {
        status: 'skip',
        reason: `no credentials for ${r.role} "${r.key}" (from ${r.source}) — set ${credential} in .env.local, or pick a model on a provider you do have.`,
      };
    }
  }

  const failures: string[] = [];
  for (const key of [...new Set(roles.map((r) => r.key))]) {
    try {
      await generateText({ model: resolveModel(key), prompt: 'Reply with the single word OK.', maxOutputTokens: 256 });
    } catch (err) {
      const who = roles.filter((r) => r.key === key).map((r) => `${r.role} from ${r.source}`).join(', ');
      failures.push(`"${key}" (${who}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length) {
    return {
      status: 'fail',
      reason:
        `model preflight failed — no fixtures were run and nothing was saved.\n  ${failures.join('\n  ')}\n` +
        'Check DEFAULT_MODEL / EVAL_MODEL / EVAL_JUDGE_MODEL / RAG_JUDGE_MODEL in .env.local and that provider\'s credentials.',
    };
  }
  return { status: 'ready' };
}

export type EvalSplit = 'dev' | 'heldout' | 'all';

/**
 * Which agent fixtures to run (EVAL_SPLIT). `dev` (default): the fixtures in
 * evals/fixtures/agent that prompts and tools are tuned against. `heldout`:
 * evals/fixtures/agent-heldout, which nobody tunes against, run to check
 * that improvements generalise. `all`: both.
 */
export function evalSplit(): EvalSplit {
  const v = process.env.EVAL_SPLIT?.trim().toLowerCase();
  return v === 'heldout' || v === 'all' ? v : 'dev';
}

export function agentFixtureDirs(split: EvalSplit = evalSplit()): string[] {
  return split === 'dev' ? ['agent'] : split === 'heldout' ? ['agent-heldout'] : ['agent', 'agent-heldout'];
}
