/**
 * Run budgets and loop detection, enforced in code rather than in the prompt.
 *
 * The step cap (maxSteps) was the only hard limit on a run. A run can burn
 * far more than it should inside that cap: every step resends a growing
 * context, and a model that keeps calling the same tool with the same
 * arguments gets identical results back until the cap fires. This tracks,
 * per model attempt:
 *
 *   - tokens (input + output, summed over steps)
 *   - estimated cost (lib/llm/pricing.ts; skipped when the model has no price)
 *   - wall-clock time since the run started (spans fallback attempts)
 *   - identical tool calls (same effective tool, same arguments)
 *
 * When a limit is hit, the agent doesn't crash: the next step is steered to
 * a written answer (same mechanism as the last-step summary) and the run
 * reports `stopReason` so callers can flag the answer as partial. A repeated
 * call first gets a warning injected into context; only if the model keeps
 * repeating does the run stop.
 */

import { estimateCostUsd } from './pricing';

export type BudgetStopReason = 'token-budget' | 'cost-budget' | 'time-budget' | 'loop-detected';

export interface RunBudgetLimits {
  /** Total tokens (input + output) across all steps. */
  maxTokens?: number;
  /** Estimated USD cost across all steps. Ignored for models with no known price. */
  maxCostUsd?: number;
  /** Wall-clock milliseconds since the run started. */
  maxDurationMs?: number;
  /** How many times one tool may be called with identical arguments before the model is warned. */
  maxIdenticalCalls: number;
}

export interface BudgetUsage {
  tokens: number;
  costUsd?: number;
  durationMs: number;
}

const DEFAULT_MAX_TOKENS = 1_500_000;
const DEFAULT_MAX_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_IDENTICAL_CALLS = 3;

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The smaller of two optional limits — a request can tighten the deployment's limit, never loosen it. */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Deployment limits from the environment, tightened by any per-request ones.
 *   RUN_MAX_TOKENS (default 1.5M), RUN_MAX_COST_USD (default none),
 *   RUN_TIMEOUT_MS (default 30 min), RUN_MAX_IDENTICAL_CALLS (default 3).
 */
export function resolveBudget(requested: Partial<RunBudgetLimits> = {}): RunBudgetLimits {
  return {
    maxTokens: tighter(envNumber('RUN_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS, requested.maxTokens),
    maxCostUsd: tighter(envNumber('RUN_MAX_COST_USD'), requested.maxCostUsd),
    maxDurationMs: tighter(envNumber('RUN_TIMEOUT_MS') ?? DEFAULT_MAX_DURATION_MS, requested.maxDurationMs),
    maxIdenticalCalls: Math.max(
      2,
      Math.floor(tighter(envNumber('RUN_MAX_IDENTICAL_CALLS') ?? DEFAULT_MAX_IDENTICAL_CALLS, requested.maxIdenticalCalls) ?? DEFAULT_MAX_IDENTICAL_CALLS)
    ),
  };
}

/** Stable JSON: object keys sorted, so {a,b} and {b,a} are the same call. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function callSignature(toolName: string, input: unknown): string {
  return `${toolName}:${stableStringify(input)}`;
}

export class RunBudgetTracker {
  private tokens = 0;
  private costUsd: number | undefined = 0;
  private readonly callCounts = new Map<string, number>();
  /** Signatures already warned about, so each gets one warning. */
  private readonly warned = new Set<string>();
  private pendingWarnings: string[] = [];
  private stopReason: BudgetStopReason | undefined;

  constructor(
    private readonly limits: RunBudgetLimits,
    private readonly modelKey: string,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Record one finished step's usage and tool calls (effective calls — call_tool already unwrapped). */
  recordStep(usage: { inputTokens?: number; outputTokens?: number }, calls: Array<{ toolName: string; input: unknown }>): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    this.tokens += input + output;
    const stepCost = estimateCostUsd(this.modelKey, { inputTokens: input, outputTokens: output });
    this.costUsd = this.costUsd === undefined || stepCost === undefined ? undefined : this.costUsd + stepCost;

    for (const call of calls) {
      const sig = callSignature(call.toolName, call.input);
      const count = (this.callCounts.get(sig) ?? 0) + 1;
      this.callCounts.set(sig, count);
      if (count > this.limits.maxIdenticalCalls && this.warned.has(sig)) {
        // Warned once already and still repeating.
        this.stopReason ??= 'loop-detected';
      } else if (count >= this.limits.maxIdenticalCalls && !this.warned.has(sig)) {
        this.warned.add(sig);
        this.pendingWarnings.push(
          `You have now called ${call.toolName} ${count} times with identical arguments. ` +
            'Its result will not change. Do not call it again with these arguments: use what you already have, ' +
            'take a meaningfully different approach, or write your final answer explaining what is blocking you.'
        );
      }
    }
    this.checkLimits();
  }

  private checkLimits(): void {
    if (this.stopReason) return;
    const { maxTokens, maxCostUsd, maxDurationMs } = this.limits;
    if (maxTokens !== undefined && this.tokens >= maxTokens) this.stopReason = 'token-budget';
    else if (maxCostUsd !== undefined && this.costUsd !== undefined && this.costUsd >= maxCostUsd) this.stopReason = 'cost-budget';
    else if (maxDurationMs !== undefined && this.now() - this.startedAt >= maxDurationMs) this.stopReason = 'time-budget';
  }

  /** Why the run must wrap up now, if it must. Re-checks the clock. */
  exceeded(): BudgetStopReason | undefined {
    this.checkLimits();
    return this.stopReason;
  }

  /** Loop warnings not yet shown to the model. Returns each once. */
  takeWarnings(): string[] {
    const out = this.pendingWarnings;
    this.pendingWarnings = [];
    return out;
  }

  usage(): BudgetUsage {
    return { tokens: this.tokens, costUsd: this.costUsd, durationMs: this.now() - this.startedAt };
  }
}

export const STOP_REASON_TEXT: Record<BudgetStopReason, string> = {
  'token-budget': 'the run reached its token budget',
  'cost-budget': 'the run reached its cost ceiling',
  'time-budget': 'the run reached its time limit',
  'loop-detected': 'the agent kept repeating the same tool call',
};

/** Instruction for the forced wrap-up step. */
export function budgetFinalNote(reason: BudgetStopReason): string {
  return (
    `Stop here: ${STOP_REASON_TEXT[reason]}. Do not call any more tools. ` +
    'Write your final answer now: what you completed, what you did not get to, and what the user should do next.'
  );
}
