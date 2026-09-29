/**
 * Eval history — what `npm run eval:*` (evals/lib/report.ts) writes and what
 * /evals reads. Backed by the MCP server's database via execute_sql, the
 * same way lib/execution-store.ts persists agent runs, so eval history
 * lives next to the run history it's grading instead of needing a second
 * database.
 *
 * Tables (created idempotently by ensureTables() on first use, dedicated to
 * the harness like harness_agent_runs):
 *   harness_eval_runs     one row per eval-file invocation
 *   harness_eval_results  one row per fixture within that run
 */

import { randomUUID } from 'crypto';
import { execSql, sqlBool, sqlInt, sqlIntOrNull, sqlStr, sqlStrOrNull } from './mcp-sql';
import type { EvalResultRecord, EvalRunDetail, EvalRunSummary } from './types';

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
      await execSql(
        `CREATE TABLE IF NOT EXISTS ${RESULTS_TABLE} (
          eval_run_id TEXT NOT NULL REFERENCES ${RUNS_TABLE}(id) ON DELETE CASCADE,
          fixture_id TEXT NOT NULL,
          passed BOOLEAN NOT NULL,
          notes TEXT NOT NULL,
          duration_ms INTEGER,
          total_tokens INTEGER,
          PRIMARY KEY (eval_run_id, fixture_id)
        )`.replace(/\s+/g, ' ')
      );
    })().catch((err) => {
      ensureTablesPromise = null; // allow retry on next call
      throw err;
    });
  }
  return ensureTablesPromise;
}

export interface SaveEvalRunInput extends Omit<EvalRunSummary, 'id' | 'passedCount' | 'totalCount'> {
  results: EvalResultRecord[];
}

/** Persist one eval run and all its fixture results. Returns the new run id. */
export async function saveEvalRun(input: SaveEvalRunInput): Promise<string> {
  await ensureTables();
  const id = randomUUID();
  const passedCount = input.results.filter((r) => r.passed).length;

  await execSql(
    `INSERT INTO ${RUNS_TABLE} (id, suite, subject, judge_model, passed_count, total_count, started_at, finished_at)
     VALUES (${sqlStr(id)}, ${sqlStr(input.suite)}, ${sqlStr(input.subject)}, ${sqlStrOrNull(input.judgeModel)},
             ${sqlInt(passedCount)}, ${sqlInt(input.results.length)}, ${sqlStr(input.startedAt)}, ${sqlStr(input.finishedAt)})`.replace(
      /\s+/g,
      ' '
    )
  );

  if (input.results.length > 0) {
    // One multi-row INSERT rather than a round trip (an MCP HTTP call) per fixture.
    const values = input.results
      .map(
        (r) =>
          `(${sqlStr(id)}, ${sqlStr(r.fixtureId)}, ${sqlBool(r.passed)}, ${sqlStr(r.notes)}, ` +
          `${sqlIntOrNull(r.durationMs)}, ${sqlIntOrNull(r.totalTokens)})`
      )
      .join(', ');
    await execSql(
      `INSERT INTO ${RESULTS_TABLE} (eval_run_id, fixture_id, passed, notes, duration_ms, total_tokens) VALUES ${values}`
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
    passedCount: Number(row.passed_count),
    totalCount: Number(row.total_count),
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: new Date(row.finished_at as string).toISOString(),
  };
}

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

/** One eval run plus every fixture-level result recorded for it. */
export async function getEvalRun(id: string): Promise<EvalRunDetail | null> {
  await ensureTables();
  const [runResult, resultsResult] = await Promise.all([
    execSql(`SELECT * FROM ${RUNS_TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`),
    execSql(`SELECT * FROM ${RESULTS_TABLE} WHERE eval_run_id = ${sqlStr(id)} ORDER BY fixture_id`),
  ]);
  const row = runResult.rows?.[0];
  if (!row) return null;
  return {
    ...rowToSummary(row),
    results: (resultsResult.rows ?? []).map((r) => ({
      fixtureId: r.fixture_id as string,
      passed: r.passed as boolean,
      notes: r.notes as string,
      durationMs: r.duration_ms == null ? undefined : Number(r.duration_ms),
      totalTokens: r.total_tokens == null ? undefined : Number(r.total_tokens),
    })),
  };
}
