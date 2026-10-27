/**
 * Production agent metrics (§5.4 "metrics that matter"), from real runs
 * rather than eval fixtures: success rate, p50/p95 latency, steps, cost per
 * successful run, escalation (approval denials), stop reasons, and the
 * online signals (sampled judge grades, user feedback).
 *
 * A run counts as successful when it completed, the model stopped on its
 * own (not cut off by the step limit or a run budget), and nothing graded
 * it as bad: no failing judge grade and no 👎. The same "divide cost by
 * successes, not runs" rule as the evals applies.
 */

import { percentile } from './eval-metrics';
import { execSql, sqlInt } from './mcp-sql';
import { estimateCostUsd } from './llm/pricing';
import { ensureQualityTable, qualityVersion } from './run-quality';

export interface ProductionRunRow {
  id: string;
  createdAt: string;
  description: string;
  model: string;
  status: 'completed' | 'failed';
  durationMs: number;
  finishReason?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The part of inputTokens read from / written to the prompt cache, priced at the cache rates. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  steps?: number;
  /** Tool calls a person (or the approval timeout) denied. */
  denied: number;
  judgePass?: boolean;
  rating?: 1 | -1;
  comment?: string;
  /** Orchestrator-worker run (Requirement 14.2): true when the coordinator ran it as workers. */
  orchestrated?: boolean;
  /** Workers this run fanned out into. */
  workerCount?: number;
  /** Replanning calls this run made. */
  replans?: number;
  /** The run ledger's cost, priced per call; set for orchestrated runs, whose workers may use another model. */
  ledgerCostUsd?: number;
}

export interface ModelBreakdown {
  model: string;
  runs: number;
  successRate: number;
  latencyP95Ms?: number;
  costPerSuccessUsd?: number;
}

export interface ProductionMetrics {
  runs: number;
  completed: number;
  successes: number;
  successRate: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  stepsMean?: number;
  totalCostUsd?: number;
  costPerSuccessUsd?: number;
  /** Share of runs with at least one denied tool call. */
  escalationRate: number;
  stopReasons: Record<string, number>;
  judged: number;
  judgePassRate?: number;
  rated: number;
  thumbsUp: number;
  thumbsDown: number;
  byModel: ModelBreakdown[];
  /** Orchestration summary over the window (Requirement 14.2). */
  orchestration: OrchestrationMetrics;
  /** Newest runs a user rated 👎 or the judge failed — the weekly trace-review queue. */
  needsReview: Array<Pick<ProductionRunRow, 'id' | 'createdAt' | 'description' | 'rating' | 'comment' | 'judgePass'>>;
}

/** Orchestrator-worker rollup for /metrics (Requirement 14.2). */
export interface OrchestrationMetrics {
  /** Runs the coordinator ran as workers. */
  orchestratedRuns: number;
  /** Share of all runs that were orchestrated. */
  orchestratedRate: number;
  /** Total workers across orchestrated runs. */
  totalWorkers: number;
  /** Mean workers per orchestrated run. */
  workersPerRun?: number;
  /** Total replanning calls across orchestrated runs. */
  totalReplans: number;
  /** Mean chat-model tokens per worker (run tokens / workers), across orchestrated runs. */
  tokensPerWorker?: number;
}

/** Orchestrator-worker rollup over the window (Requirement 14.2). */
export function computeOrchestration(rows: ProductionRunRow[]): OrchestrationMetrics {
  const orchestrated = rows.filter((r) => r.orchestrated);
  const totalWorkers = sum(orchestrated.map((r) => r.workerCount ?? 0));
  const totalReplans = sum(orchestrated.map((r) => r.replans ?? 0));
  // Per-worker tokens: run chat-model tokens summed over orchestrated runs,
  // divided by the workers they ran. A rough per-worker figure for comparison.
  const tokens = sum(orchestrated.map((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0)));
  return {
    orchestratedRuns: orchestrated.length,
    orchestratedRate: rows.length ? orchestrated.length / rows.length : 0,
    totalWorkers,
    workersPerRun: orchestrated.length ? totalWorkers / orchestrated.length : undefined,
    totalReplans,
    tokensPerWorker: totalWorkers ? tokens / totalWorkers : undefined,
  };
}

export function isSuccess(r: ProductionRunRow): boolean {
  return r.status === 'completed' && r.finishReason === 'stop' && !r.stopReason && r.judgePass !== false && r.rating !== -1;
}

function runCost(r: ProductionRunRow): number | undefined {
  if (r.orchestrated && r.ledgerCostUsd !== undefined) return r.ledgerCostUsd;
  return estimateCostUsd(r.model, {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
  });
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Total cost, only when every run could be priced (otherwise it would silently undercount). */
function totalCost(rows: ProductionRunRow[]): number | undefined {
  const costs = rows.map(runCost);
  return rows.length && costs.every((c) => c !== undefined) ? sum(costs as number[]) : undefined;
}

export function computeProductionMetrics(rows: ProductionRunRow[]): ProductionMetrics {
  const successes = rows.filter(isSuccess);
  const durations = rows.map((r) => r.durationMs);
  const steps = rows.map((r) => r.steps).filter((s): s is number => s !== undefined);
  const cost = totalCost(rows);
  const judged = rows.filter((r) => r.judgePass !== undefined);
  const rated = rows.filter((r) => r.rating !== undefined);

  const stopReasons: Record<string, number> = {};
  for (const r of rows) {
    const key = r.status === 'failed' ? 'failed' : (r.stopReason ?? (r.finishReason === 'stop' ? 'finished' : `cut off (${r.finishReason ?? 'unknown'})`));
    stopReasons[key] = (stopReasons[key] ?? 0) + 1;
  }

  const models = [...new Set(rows.map((r) => r.model))];
  const byModel = models
    .map((model) => {
      const mine = rows.filter((r) => r.model === model);
      const ok = mine.filter(isSuccess);
      const c = totalCost(mine);
      return {
        model,
        runs: mine.length,
        successRate: ok.length / mine.length,
        latencyP95Ms: percentile(mine.map((r) => r.durationMs), 95),
        costPerSuccessUsd: c !== undefined && ok.length ? c / ok.length : undefined,
      };
    })
    .sort((a, b) => b.runs - a.runs);

  const orchestration = computeOrchestration(rows);

  return {
    runs: rows.length,
    completed: rows.filter((r) => r.status === 'completed').length,
    successes: successes.length,
    successRate: rows.length ? successes.length / rows.length : 0,
    latencyP50Ms: percentile(durations, 50),
    latencyP95Ms: percentile(durations, 95),
    stepsMean: steps.length ? sum(steps) / steps.length : undefined,
    totalCostUsd: cost,
    costPerSuccessUsd: cost !== undefined && successes.length ? cost / successes.length : undefined,
    escalationRate: rows.length ? rows.filter((r) => r.denied > 0).length / rows.length : 0,
    stopReasons,
    judged: judged.length,
    judgePassRate: judged.length ? judged.filter((r) => r.judgePass).length / judged.length : undefined,
    rated: rated.length,
    thumbsUp: rated.filter((r) => r.rating === 1).length,
    thumbsDown: rated.filter((r) => r.rating === -1).length,
    byModel,
    orchestration,
    needsReview: rows
      .filter((r) => r.rating === -1 || r.judgePass === false)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 20)
      .map(({ id, createdAt, description, rating, comment, judgePass }) => ({ id, createdAt, description, rating, comment, judgePass })),
  };
}

const MAX_RUNS = 5_000;

/**
 * How long a window's rows are reused. The query unpacks every step's tool
 * results for up to MAX_RUNS runs, so reloading /metrics shouldn't rerun it.
 * A new rating or judgment reloads at once (qualityVersion).
 */
const RUNS_CACHE_TTL_MS = 60_000;
const runsCache = new Map<number, { expires: number; version: number; rows: Promise<ProductionRunRow[]> }>();

/** Runs from the last `days` days (newest first, capped), joined with their quality signals. */
export function loadProductionRuns(days: number): Promise<ProductionRunRow[]> {
  const version = qualityVersion();
  const hit = runsCache.get(days);
  if (hit && hit.version === version && hit.expires > Date.now()) return hit.rows;
  const rows = queryProductionRuns(days);
  runsCache.set(days, { expires: Date.now() + RUNS_CACHE_TTL_MS, version, rows });
  rows.catch(() => {
    if (runsCache.get(days)?.rows === rows) runsCache.delete(days); // don't keep a failure
  });
  return rows;
}

async function queryProductionRuns(days: number): Promise<ProductionRunRow[]> {
  await ensureQualityTable();
  const result = await execSql(
    `SELECT r.id, r.created_at, r.description, r.model, r.status, r.duration_ms,
            r.result->>'finishReason' AS finish_reason,
            r.result->>'stopReason' AS stop_reason,
            (r.result->'usage'->>'inputTokens')::bigint AS input_tokens,
            (r.result->'usage'->>'outputTokens')::bigint AS output_tokens,
            (r.result->'usage'->>'cacheReadTokens')::bigint AS cache_read_tokens,
            (r.result->'usage'->>'cacheWriteTokens')::bigint AS cache_write_tokens,
            jsonb_array_length(COALESCE(r.result->'steps', '[]'::jsonb)) AS steps,
            (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.result->'steps', '[]'::jsonb)) s,
                    jsonb_array_elements(COALESCE(s->'toolResults', '[]'::jsonb)) t
              WHERE t->>'error' LIKE 'Not executed:%') AS denied,
            (r.result->>'orchestrated')::boolean AS orchestrated,
            jsonb_array_length(COALESCE(r.result->'workers', '[]'::jsonb)) AS worker_count,
            (r.result->>'replans')::int AS replans,
            (r.result->'budgetUsage'->>'costUsd')::float8 AS ledger_cost_usd,
            q.judge_pass, q.rating, q.comment
       FROM harness_agent_runs r
       LEFT JOIN harness_run_quality q ON q.run_id = r.id
      WHERE r.created_at >= now() - (${sqlInt(days)} || ' days')::interval
      ORDER BY r.created_at DESC
      LIMIT ${MAX_RUNS}`.replace(/\s+/g, ' ')
  );
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  return (result.rows ?? []).map((row) => ({
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    status: row.status as ProductionRunRow['status'],
    durationMs: Number(row.duration_ms),
    finishReason: (row.finish_reason as string | null) ?? undefined,
    stopReason: (row.stop_reason as string | null) ?? undefined,
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    steps: row.status === 'completed' ? num(row.steps) : undefined,
    denied: Number(row.denied ?? 0),
    orchestrated: (row.orchestrated as boolean | null) ?? undefined,
    workerCount: num(row.worker_count),
    replans: num(row.replans),
    ledgerCostUsd: num(row.ledger_cost_usd),
    judgePass: (row.judge_pass as boolean | null) ?? undefined,
    rating: (row.rating as 1 | -1 | null) ?? undefined,
    comment: (row.comment as string | null) ?? undefined,
  }));
}
