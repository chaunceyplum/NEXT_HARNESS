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
  /**
   * Run ledger this tracker charges in addition to itself, when it is a
   * worker's child budget. Single-agent trackers have no parent and behave
   * exactly as before. Loop detection stays on the child; the parent only
   * accumulates tokens, cost and the run clock.
   */
  private readonly parent: RunLedger | undefined;

  constructor(
    private readonly limits: RunBudgetLimits,
    private readonly modelKey: string,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
    parent?: RunLedger
  ) {
    this.parent = parent;
  }

  /** Record one finished step's usage and tool calls (effective calls — call_tool already unwrapped). */
  recordStep(usage: { inputTokens?: number; outputTokens?: number }, calls: Array<{ toolName: string; input: unknown }>): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    this.tokens += input + output;
    const stepCost = estimateCostUsd(this.modelKey, { inputTokens: input, outputTokens: output });
    this.costUsd = this.costUsd === undefined || stepCost === undefined ? undefined : this.costUsd + stepCost;
    // A worker step charges the run ledger too, so the run's limits hold no
    // matter how many workers run. Cost is charged at the child's model price.
    this.parent?.charge(input + output, stepCost);

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

  /**
   * Why the run must wrap up now, if it must. Re-checks the clock. A worker's
   * tracker reports the run ledger's reason when the ledger is exhausted,
   * even if the worker's own child budget still has room.
   */
  exceeded(): BudgetStopReason | undefined {
    this.checkLimits();
    return this.stopReason ?? this.parent?.exhausted();
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

/**
 * One run-level budget shared by every worker of an orchestrated run.
 *
 * The ledger holds the run's resolved limits and accumulates the tokens,
 * cost and wall-clock time of all workers. Each worker gets a child
 * `RunBudgetTracker` from `child(modelKey, share)` whose own limits are
 * capped at `share` of what the run has left when the worker starts, so one
 * worker can never spend more than its slice, and no set of workers can spend
 * past the run's limits. The child charges the ledger on every step; the
 * ledger never does loop detection (that stays per worker).
 *
 * Single-agent runs do not use a ledger: they build a plain
 * `RunBudgetTracker` with no parent, so their behaviour is unchanged.
 */
export class RunLedger {
  private tokens = 0;
  private costUsd: number | undefined = 0;
  private stopReason: BudgetStopReason | undefined;

  constructor(
    private readonly limits: RunBudgetLimits,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * A child budget for one worker, capped at `share` of the run's remaining
   * tokens and cost. The child shares the run clock (same `startedAt` and
   * `now`) and charges this ledger on every recorded step.
   */
  child(modelKey: string, share: number): RunBudgetTracker {
    return new RunBudgetTracker(this.childLimits(share), modelKey, this.startedAt, this.now, this);
  }

  /**
   * The sliced limits a child worker should get now — `share` of the run's
   * remaining tokens and cost, with the run's clock and repeat limit copied
   * through. Exposed so a caller (a worker) can hand these to executeLoop,
   * which rebuilds its own tracker per model attempt (pointing back at this
   * ledger) rather than reusing a single child() tracker across a fallback.
   */
  childLimits(share: number): RunBudgetLimits {
    const clamped = Math.min(1, Math.max(0, share));
    return {
      maxTokens: scaleRemaining(this.limits.maxTokens, this.tokens, clamped),
      maxCostUsd: scaleRemaining(this.limits.maxCostUsd, this.costUsd ?? 0, clamped),
      maxDurationMs: this.limits.maxDurationMs,
      maxIdenticalCalls: this.limits.maxIdenticalCalls,
    };
  }

  /** Add a worker step's tokens and cost to the run totals. Called by child trackers. */
  charge(tokens: number, costUsd: number | undefined): void {
    this.tokens += tokens;
    this.costUsd = this.costUsd === undefined || costUsd === undefined ? undefined : this.costUsd + costUsd;
    this.checkLimits();
  }

  private checkLimits(): void {
    if (this.stopReason) return;
    const { maxTokens, maxCostUsd, maxDurationMs } = this.limits;
    if (maxTokens !== undefined && this.tokens >= maxTokens) this.stopReason = 'token-budget';
    else if (maxCostUsd !== undefined && this.costUsd !== undefined && this.costUsd >= maxCostUsd) this.stopReason = 'cost-budget';
    else if (maxDurationMs !== undefined && this.now() - this.startedAt >= maxDurationMs) this.stopReason = 'time-budget';
  }

  /** Why the run must start no new workers and wrap up, if it must. Re-checks the clock. */
  exhausted(): BudgetStopReason | undefined {
    this.checkLimits();
    return this.stopReason;
  }

  usage(): BudgetUsage {
    return { tokens: this.tokens, costUsd: this.costUsd, durationMs: this.now() - this.startedAt };
  }
}

/** `share` of what a limit has left (limit − used), floored at 0. Undefined limits stay undefined. */
function scaleRemaining(limit: number | undefined, used: number, share: number): number | undefined {
  if (limit === undefined) return undefined;
  return Math.max(0, limit - used) * share;
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
