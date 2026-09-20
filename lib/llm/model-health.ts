/**
 * Model-health circuit breaker with same-tier fallback.
 *
 * Motivation (from real production data): the harness's own execution history
 * (`harness_agent_runs`) showed that essentially every failed run was a
 * provider-side problem against a *single* model key — a Bedrock model-access
 * grant missing ("Forbidden" / "Operation not allowed" / "is not available
 * for this account"), a bad/missing Anthropic API key, or an exhausted quota
 * ("credit balance is too low"). There was no fallback: one unhealthy model
 * took down otherwise-valid runs.
 *
 * This breaker fixes that class of failure. It:
 *   - Classifies an error as a "provider health" failure (access / auth /
 *     quota) vs. anything else (a context-length overflow, a tool bug, a
 *     logic error — none of which switching models would help).
 *   - Records provider-health failures per model key, and marks a key
 *     UNHEALTHY once it crosses a threshold within a rolling window, for a
 *     cooldown period.
 *   - Given a model key and the registry, picks the next HEALTHY model in the
 *     same tier to fall back to.
 *
 * It intentionally does NOT change behaviour for an explicitly pinned model
 * beyond recording health — the decision of whether to actually fall back
 * lives in the agent loop (lib/llm/agent.ts), which only auto-falls-back for
 * unpinned (default-model) requests so a caller that pinned a specific model
 * still sees that model's real error.
 */

import type { ModelRegistryEntry } from './model-registry';

export type ProviderFailureKind = 'access' | 'auth' | 'quota';

/** Patterns drawn from the live harness_agent_runs failure population. */
const PROVIDER_FAILURE_RULES: Array<{ kind: ProviderFailureKind; pattern: RegExp }> = [
  { kind: 'auth', pattern: /invalid x-api-key/i },
  { kind: 'auth', pattern: /api key is missing/i },
  { kind: 'quota', pattern: /credit balance is too low/i },
  { kind: 'quota', pattern: /quota|rate limit exceeded|too many requests/i },
  { kind: 'access', pattern: /is not available for this account/i },
  { kind: 'access', pattern: /operation not allowed/i },
  { kind: 'access', pattern: /\bforbidden\b/i },
  { kind: 'access', pattern: /access denied|not authorized|accessdenied/i },
];

/**
 * Classify an error message as a provider-health failure, or null if it's
 * something switching models wouldn't fix (e.g. a context-length overflow).
 */
export function classifyProviderFailure(message: string): ProviderFailureKind | null {
  // A context-length overflow is NOT a health failure — the same-tier
  // sibling shares the same context window, so falling back wouldn't help.
  if (/prompt is too long|context length|maximum context/i.test(message)) return null;
  for (const rule of PROVIDER_FAILURE_RULES) {
    if (rule.pattern.test(message)) return rule.kind;
  }
  return null;
}

export interface ModelHealthOptions {
  /** Provider-health failures within the window before a model is tripped. */
  failureThreshold?: number;
  /** Rolling window (ms) over which failures are counted. */
  windowMs?: number;
  /** How long (ms) a tripped model stays unhealthy before it's retried. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface FailureRecord {
  timestamps: number[];
  trippedAt: number | null;
}

const DEFAULTS = {
  failureThreshold: 2,
  windowMs: 15 * 60 * 1000, // 15 minutes
  cooldownMs: 10 * 60 * 1000, // 10 minutes
};

export class ModelHealthTracker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, FailureRecord>();

  constructor(opts: ModelHealthOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  /** Record a provider-health failure for a model key. */
  recordFailure(modelKey: string): void {
    const t = this.now();
    const rec = this.records.get(modelKey) ?? { timestamps: [], trippedAt: null };
    rec.timestamps = rec.timestamps.filter((ts) => t - ts < this.windowMs);
    rec.timestamps.push(t);
    if (rec.timestamps.length >= this.failureThreshold) {
      rec.trippedAt = t;
    }
    this.records.set(modelKey, rec);
  }

  /** A successful call clears a model's failure history. */
  recordSuccess(modelKey: string): void {
    this.records.delete(modelKey);
  }

  /** True if the model is currently tripped and still within its cooldown. */
  isUnhealthy(modelKey: string): boolean {
    const rec = this.records.get(modelKey);
    if (!rec || rec.trippedAt === null) return false;
    if (this.now() - rec.trippedAt >= this.cooldownMs) {
      // Cooldown elapsed — give it another chance.
      this.records.delete(modelKey);
      return false;
    }
    return true;
  }

  /**
   * Pick the next healthy model in the same tier as `modelKey`, excluding the
   * key itself and anything already tried. Returns null if there's no healthy
   * same-tier alternative.
   */
  pickFallback(
    modelKey: string,
    registry: ModelRegistryEntry[],
    tried: ReadonlySet<string> = new Set()
  ): string | null {
    const current = registry.find((e) => e.key === modelKey);
    if (!current) return null;
    const candidate = registry.find(
      (e) => e.tier === current.tier && e.key !== modelKey && !tried.has(e.key) && !this.isUnhealthy(e.key)
    );
    return candidate ? candidate.key : null;
  }
}

/**
 * Process-wide default tracker. Overridable via env for operators who want a
 * more/less aggressive breaker without a code change.
 */
export const defaultModelHealth = new ModelHealthTracker({
  failureThreshold: numberFromEnv('MODEL_HEALTH_FAILURE_THRESHOLD'),
  windowMs: numberFromEnv('MODEL_HEALTH_WINDOW_MS'),
  cooldownMs: numberFromEnv('MODEL_HEALTH_COOLDOWN_MS'),
});

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
