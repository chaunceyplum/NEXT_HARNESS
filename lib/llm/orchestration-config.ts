/**
 * Environment readers for orchestrator-worker mode (Requirements 2.1, 3.1,
 * 4.1, 4.8, 6.1, 8.2, 13.3).
 *
 * The coordinator and workers (later phases) read their limits from here so
 * the defaults and parsing live in one place. Every reader falls back to the
 * documented default when the variable is unset or malformed, so a bad value
 * never crashes a run — it just behaves as if unset. The concurrency reader
 * `maxAgentLoops` lives in `agent-slots.ts` with the semaphore it bounds.
 *
 * All of these are documented in `.env.local.example` and
 * `ENVIRONMENT_VARIABLES.md`.
 */

/** `ORCHESTRATION`: whether the coordinator may run at all, and how eagerly. */
export type OrchestrationFlag = 'off' | 'on' | 'always';

const ORCHESTRATION_FLAGS: ReadonlySet<string> = new Set<OrchestrationFlag>(['off', 'on', 'always']);

/** Defaults from the design's configuration table. */
const DEFAULTS = {
  maxWorkers: 3,
  workerMaxSteps: 6,
  workerBudgetShare: 0.5,
  maxReplans: 2,
  maxActiveRuns: 6,
} as const;

/** A positive integer env var, or the default when unset/malformed. */
function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** `ORCHESTRATION` (default `off`). Unknown values read as `off`. */
export function orchestrationFlag(): OrchestrationFlag {
  const raw = process.env.ORCHESTRATION?.trim().toLowerCase();
  return raw && ORCHESTRATION_FLAGS.has(raw) ? (raw as OrchestrationFlag) : 'off';
}

/** `MAX_WORKERS` (default 3): concurrent workers per run. */
export function maxWorkers(): number {
  return envInt('MAX_WORKERS', DEFAULTS.maxWorkers);
}

/** `WORKER_MAX_STEPS` (default 6): step cap per worker loop. */
export function workerMaxSteps(): number {
  return envInt('WORKER_MAX_STEPS', DEFAULTS.workerMaxSteps);
}

/**
 * `WORKER_BUDGET_SHARE` (default 0.5): the most of the run ledger's remaining
 * tokens and cost one worker may be given when it starts. Clamped to (0, 1].
 */
export function workerBudgetShare(): number {
  const raw = process.env.WORKER_BUDGET_SHARE?.trim();
  if (!raw) return DEFAULTS.workerBudgetShare;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULTS.workerBudgetShare;
}

/** `MAX_REPLANS` (default 2): replanning calls allowed per run. Floor is 0. */
export function maxReplans(): number {
  const raw = process.env.MAX_REPLANS?.trim();
  if (!raw) return DEFAULTS.maxReplans;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS.maxReplans;
}

/**
 * `WORKER_MODEL`: optional registry key workers run on instead of the run's
 * model (the coordinator's synthesis always uses the run's model). Unset =
 * workers use the run's model.
 */
export function workerModel(): string | undefined {
  const raw = process.env.WORKER_MODEL?.trim();
  return raw ? raw : undefined;
}

/**
 * `LAUNCH_PARALLEL_WRITES` (default false): whether write/destructive workers
 * in a Launch run may run concurrently. False keeps them serial.
 */
export function launchParallelWrites(): boolean {
  return process.env.LAUNCH_PARALLEL_WRITES?.trim().toLowerCase() === 'true';
}

/**
 * `MAX_ACTIVE_RUNS` (default 6): active runs at which `POST /api/build`
 * rejects new runs with 429 `TOO_MANY_RUNS` (Requirement 13.3).
 */
export function maxActiveRuns(): number {
  return envInt('MAX_ACTIVE_RUNS', DEFAULTS.maxActiveRuns);
}
