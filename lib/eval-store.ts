/**
 * Eval history — what `npm run eval:*` (evals/lib/report.ts) writes and what
 * /evals reads. Backed by the MCP server's database via execute_sql, the
 * same way lib/execution-store.ts persists agent runs, so eval history
 * lives next to the run history it's grading instead of needing a second
 * database.
 *
 * Tables (created/migrated idempotently by ensureTables() on first use,
 * dedicated to the harness like harness_agent_runs):
 *   harness_eval_runs     one row per eval-file invocation, with its metrics
 *   harness_eval_results  one row per fixture TRIAL within that run
 */

import { randomUUID } from 'crypto';
import { computeRunMetrics, type EvalRunMetrics } from './eval-metrics';
import {
  execSql,
  sqlBool,
  sqlInt,
  sqlIntOrNull,
  sqlJsonOrNull,
  sqlStr,
  sqlStrOrNull,
} from './mcp-sql';
import type { EvalRunDetail, EvalRunSummary, EvalTrialRecord } from './types';

const RUNS_TABLE = 'harness_eval_runs';
const RESULTS_TABLE = 'harness_eval_results';

let ensureTablesPromise: Promise<void> | null = null;

function ensureTables(): Promise<void> {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await execSql(
        `CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
          id TEXT PRIMARY KEY,
          suite TEXT NOT NULL,
          subject TEXT NOT NULL,
          judge_model TEXT,
          passed_count INTEGER NOT NULL,
          total_count INTEGER NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ NOT NULL
        )`.replace(/\s+/g, ' ')
      );
      await execSql(`CREATE INDEX IF NOT EXISTS ${RUNS_TABLE}_started_at_idx ON ${RUNS_TABLE} (started_at DESC)`);
      // Added after the first release of these tables — ADD COLUMN IF NOT
      // EXISTS so a table created by that release migrates in place.
      await execSql(
        `ALTER TABLE ${RUNS_TABLE}
          ADD COLUMN IF NOT EXISTS trials_per_fixture INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS prompt_version TEXT,
          ADD COLUMN IF NOT EXISTS metrics JSONB`.replace(/\s+/g, ' ')
      );

      await execSql(
        `CREATE TABLE IF NOT EXISTS ${RESULTS_TABLE} (
          eval_run_id TEXT NOT NULL REFERENCES ${RUNS_TABLE}(id) ON DELETE CASCADE,
          fixture_id TEXT NOT NULL,
          passed BOOLEAN NOT NULL,
          notes TEXT NOT NULL,
          duration_ms INTEGER,
          total_tokens INTEGER
        )`.replace(/\s+/g, ' ')
      );
      await execSql(
        `ALTER TABLE ${RESULTS_TABLE}
          ADD COLUMN IF NOT EXISTS trial INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS category TEXT,
          ADD COLUMN IF NOT EXISTS structural_passed BOOLEAN,
          ADD COLUMN IF NOT EXISTS safety_violation BOOLEAN,
          ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS steps INTEGER,
          ADD COLUMN IF NOT EXISTS tool_calls INTEGER,
          ADD COLUMN IF NOT EXISTS errored BOOLEAN`.replace(/\s+/g, ' ')
      );
      // The first release keyed rows by (run, fixture); trials need
      // (run, fixture, trial). Dropping a constraint that's already gone and
      // creating an index that already exists are both no-ops.
      await execSql(`ALTER TABLE ${RESULTS_TABLE} DROP CONSTRAINT IF EXISTS ${RESULTS_TABLE}_pkey`);
      await execSql(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${RESULTS_TABLE}_trial_idx ON ${RESULTS_TABLE} (eval_run_id, fixture_id, trial)`
      );
    })().catch((err) => {
      ensureTablesPromise = null; // allow retry on next call
      throw err;
    });
  }
  return ensureTablesPromise;
}

export interface SaveEvalRunInput {
  suite: EvalRunSummary['suite'];
  subject: string;
  judgeModel?: string;
  promptVersion?: string;
  startedAt: string;
  finishedAt: string;
  results: EvalTrialRecord[];
}

function sqlFloatOrNull(value: number | null | undefined): string {
  if (value == null) return 'NULL';
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for SQL: ${value}`);
  return String(value);
}

function sqlBoolOrNull(value: boolean | null | undefined): string {
  return value == null ? 'NULL' : sqlBool(value);
}

/** Persist one eval run and all its trial results. Returns the new run id. */
export async function saveEvalRun(input: SaveEvalRunInput): Promise<string> {
  await ensureTables();
  const id = randomUUID();
  const metrics = computeRunMetrics(input.results);
  const passedCount = input.results.filter((r) => r.passed).length;

  await execSql(
    `INSERT INTO ${RUNS_TABLE}
       (id, suite, subject, judge_model, prompt_version, passed_count, total_count, trials_per_fixture, metrics, started_at, finished_at)
     VALUES (${sqlStr(id)}, ${sqlStr(input.suite)}, ${sqlStr(input.subject)}, ${sqlStrOrNull(input.judgeModel)},
             ${sqlStrOrNull(input.promptVersion)}, ${sqlInt(passedCount)}, ${sqlInt(input.results.length)},
             ${sqlInt(metrics.k)}, ${sqlJsonOrNull(metrics)}, ${sqlStr(input.startedAt)}, ${sqlStr(input.finishedAt)})`.replace(
      /\s+/g,
      ' '
    )
  );

  if (input.results.length > 0) {
    // One multi-row INSERT rather than a round trip (an MCP HTTP call) per trial.
    const values = input.results
      .map(
        (r) =>
          `(${sqlStr(id)}, ${sqlStr(r.fixtureId)}, ${sqlInt(r.trial)}, ${sqlBool(r.passed)}, ${sqlStr(r.notes)}, ` +
          `${sqlStrOrNull(r.category)}, ${sqlBoolOrNull(r.structuralPassed)}, ${sqlBoolOrNull(r.safetyViolation)}, ` +
          `${sqlIntOrNull(r.durationMs)}, ${sqlIntOrNull(r.totalTokens)}, ${sqlFloatOrNull(r.costUsd)}, ` +
          `${sqlIntOrNull(r.steps)}, ${sqlIntOrNull(r.toolCalls)}, ${sqlBoolOrNull(r.errored)})`
      )
      .join(', ');
    await execSql(
      `INSERT INTO ${RESULTS_TABLE}
         (eval_run_id, fixture_id, trial, passed, notes, category, structural_passed, safety_violation,
          duration_ms, total_tokens, cost_usd, steps, tool_calls, errored)
       VALUES ${values}`.replace(/\s+/g, ' ')
    );
  }

  return id;
}

function rowToSummary(row: Record<string, unknown>): EvalRunSummary {
  return {
    id: row.id as string,
    suite: row.suite as EvalRunSummary['suite'],
    subject: row.subject as string,
    judgeModel: (row.judge_model as string | null) ?? undefined,
    promptVersion: (row.prompt_version as string | null) ?? undefined,
    passedCount: Number(row.passed_count),
    totalCount: Number(row.total_count),
    trialsPerFixture: Number(row.trials_per_fixture ?? 1),
    metrics: (row.metrics as EvalRunMetrics | null) ?? undefined,
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: new Date(row.finished_at as string).toISOString(),
  };
}

const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const bool = (v: unknown): boolean | undefined => (v == null ? undefined : (v as boolean));

/** Newest-first, paginated. */
export async function listEvalRuns(
  opts: { limit?: number; offset?: number } = {}
): Promise<{ evalRuns: EvalRunSummary[]; total: number }> {
  await ensureTables();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const [listResult, countResult] = await Promise.all([
    execSql(`SELECT * FROM ${RUNS_TABLE} ORDER BY started_at DESC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}`),
    execSql(`SELECT count(*) AS total FROM ${RUNS_TABLE}`),
  ]);
  return {
    evalRuns: (listResult.rows ?? []).map(rowToSummary),
    total: Number(countResult.rows?.[0]?.total ?? 0),
  };
}

/** One eval run plus every trial result recorded for it. */
export async function getEvalRun(id: string): Promise<EvalRunDetail | null> {
  await ensureTables();
  const [runResult, resultsResult] = await Promise.all([
    execSql(`SELECT * FROM ${RUNS_TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`),
    execSql(`SELECT * FROM ${RESULTS_TABLE} WHERE eval_run_id = ${sqlStr(id)} ORDER BY fixture_id, trial`),
  ]);
  const row = runResult.rows?.[0];
  if (!row) return null;
  const results: EvalTrialRecord[] = (resultsResult.rows ?? []).map((r) => ({
    fixtureId: r.fixture_id as string,
    trial: Number(r.trial ?? 1),
    passed: r.passed as boolean,
    errored: bool(r.errored),
    notes: r.notes as string,
    category: (r.category as string | null) ?? undefined,
    structuralPassed: bool(r.structural_passed),
    safetyViolation: bool(r.safety_violation),
    durationMs: num(r.duration_ms),
    totalTokens: num(r.total_tokens),
    costUsd: num(r.cost_usd),
    steps: num(r.steps),
    toolCalls: num(r.tool_calls),
  }));
  const summary = rowToSummary(row);
  // Runs saved before metrics existed get them computed on read.
  return { ...summary, metrics: summary.metrics ?? computeRunMetrics(results), results };
}
