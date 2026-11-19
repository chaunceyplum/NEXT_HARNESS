/**
 * Run history / replayability — backed by the MCP server's own
 * database via the `execute_sql` tool (full read/write/DDL access, unlike
 * the read-only query_rag_db), not local files.
 *
 * Table: harness_agent_runs, created by ensureTable() the first time this
 * module is used (idempotent — CREATE TABLE/INDEX IF NOT EXISTS). Dedicated
 * to the harness — write into it and nothing else in this database, since
 * the schema is only guaranteed correct for what this file defines.
 *
 * `allow_full_build`/`execution_id` are retained columns from when the
 * harness could opt into a full end-to-end build tool; that tool isn't in
 * the connected MCP server's catalog (verified against its live tools/list,
 * Aug 2026), so every run now persists with allow_full_build = false and
 * execution_id = NULL. Kept rather than dropped to avoid a schema migration
 * against a live table; the app model (RunSummary) no longer carries them.
 *
 * execute_sql takes a raw SQL string with no parameter binding, so every
 * value below is escaped by hand (sqlStr/sqlJson/etc., lib/mcp-sql.ts)
 * rather than using placeholders — see those helpers for exactly how.
 */

import { randomUUID } from 'crypto';
import { ACTIVE_STATUSES } from './run-lifecycle';
import { execSql, sqlInt, sqlJson, sqlJsonOrNull, sqlStr, sqlStrOrNull } from './mcp-sql';
import type { LineageRecord, RunRecord, RunSummary } from './types';

const TABLE = 'harness_agent_runs';

// ── Schema ─────────────────────────────────────────────────────────────

let ensureTablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await execSql(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          description TEXT NOT NULL,
          model TEXT NOT NULL,
          allow_full_build BOOLEAN NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          tools_considered JSONB,
          execution_id TEXT,
          request JSONB NOT NULL,
          result JSONB,
          error TEXT
        )`.replace(/\s+/g, ' ')
      );
      await execSql(`CREATE INDEX IF NOT EXISTS ${TABLE}_created_at_idx ON ${TABLE} (created_at DESC)`);
    })().catch((err) => {
      ensureTablePromise = null; // allow retry on next call
      throw err;
    });
  }
  return ensureTablePromise;
}

/**
 * Version of the checkpoint shape saved mid-run (RunResult.checkpoint);
 * bump when it changes.
 *
 * v2 (orchestrator-workers): the result JSONB may carry `orchestrated`,
 * `replans` and `workers` (Requirement 12.1). v1 records never do, so a record
 * whose checkpoint schemaVersion is 1 (or absent) is read as single-agent —
 * `orchestrated` is treated as false and `workers` as empty (Requirement 12.3).
 * No table schema change: the fields live inside the existing `result` column.
 */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** The first checkpoint schema version that could store orchestrated runs. */
const ORCHESTRATION_SCHEMA_VERSION = 2;

/**
 * Mark runs left active ('running' or 'awaiting_approval', see
 * lib/run-lifecycle.ts) by a previous server process as 'interrupted'.
 * Called once at startup (instrumentation.ts): with runs executing in
 * this process, nothing else can still be working on them.
 */
export async function markInterruptedRuns(): Promise<number> {
  await ensureTable();
  const result = await execSql(
    `UPDATE ${TABLE} SET status = 'interrupted' WHERE status IN (${ACTIVE_STATUSES.map(sqlStr).join(', ')}) RETURNING id`
  );
  return result.rows?.length ?? 0;
}

export function newRunId(): string {
  return randomUUID();
}

// ── Row <-> RunRecord mapping ───────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): RunRecord {
  const result = normaliseResult((row.result as RunRecord['result'] | null) ?? undefined);
  return {
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    status: row.status as RunRecord['status'],
    durationMs: row.duration_ms as number,
    toolsConsidered: (row.tools_considered as string[] | null) ?? undefined,
    // Absent on rows persisted before token tracking was added (result has no `usage` key) — never a schema concern since it's read out of the existing `result` JSONB column, not a dedicated one.
    usage: result?.usage,
    request: row.request as RunRecord['request'],
    result,
    error: (row.error as string | null) ?? undefined,
  };
}

/**
 * Read a stored result in a version-aware way (Requirement 12.3). A record
 * whose checkpoint says schema v1 predates orchestration, so it is always a
 * single-agent run: any orchestration fields that somehow appear on it are
 * dropped so it is never mistaken for an orchestrated run on resume or render.
 *
 * Only a mid-run checkpoint carries a schema version; a completed run's
 * record has none. A record with no checkpoint is returned as-is: v1 code
 * never wrote orchestration fields, so any it carries came from v2+.
 */
export function normaliseResult(result: RunRecord['result'] | undefined): RunRecord['result'] | undefined {
  if (!result) return result;
  const version = result.checkpoint?.schemaVersion;
  if (version === undefined || version >= ORCHESTRATION_SCHEMA_VERSION) return result;
  if (result.orchestrated === undefined && result.workers === undefined && result.replans === undefined) {
    return result;
  }
  const { orchestrated: _o, replans: _r, workers: _w, ...rest } = result;
  void _o;
  void _r;
  void _w;
  return rest;
}

// ── Public API (same shape as the old file-based store) ──────────────────

export async function saveRun(record: RunRecord): Promise<void> {
  await ensureTable();
  const sql = `
    INSERT INTO ${TABLE}
      (id, created_at, description, model, allow_full_build, status, duration_ms, tools_considered, execution_id, request, result, error)
    VALUES
      (${sqlStr(record.id)}, ${sqlStr(record.createdAt)}, ${sqlStr(record.description)}, ${sqlStr(record.model)},
       FALSE, ${sqlStr(record.status)}, ${sqlInt(record.durationMs)},
       ${sqlJsonOrNull(record.toolsConsidered)}, NULL,
       ${sqlJson(record.request)}, ${sqlJsonOrNull(record.result)}, ${sqlStrOrNull(record.error)})
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      duration_ms = EXCLUDED.duration_ms,
      tools_considered = EXCLUDED.tools_considered,
      result = EXCLUDED.result,
      error = EXCLUDED.error
  `.replace(/\s+/g, ' ');

  await execSql(sql);
}

export async function getRun(id: string): Promise<RunRecord | null> {
  await ensureTable();
  const result = await execSql(`SELECT * FROM ${TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`);
  const row = result.rows?.[0];
  return row ? rowToRecord(row) : null;
}

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
}

/** Newest-first, paginated. Excludes request/result/error (fetched in full via getRun). */
export async function listRuns(opts: ListRunsOptions = {}): Promise<{ runs: RunSummary[]; total: number }> {
  await ensureTable();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const [listResult, countResult] = await Promise.all([
    execSql(
      // result->'usage' pulls just that sub-object out of the existing
      // result JSONB column (NULL on rows from before token tracking was
      // added, or on failed runs) — no schema change, unlike adding a
      // dedicated column would have needed.
      `SELECT id, created_at, description, model, status, duration_ms, tools_considered, result->'usage' AS usage
       FROM ${TABLE} ORDER BY created_at DESC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}`.replace(/\s+/g, ' ')
    ),
    execSql(`SELECT count(*) AS total FROM ${TABLE}`),
  ]);

  const runs: RunSummary[] = (listResult.rows ?? []).map((row) => ({
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    status: row.status as RunSummary['status'],
    durationMs: row.duration_ms as number,
    toolsConsidered: (row.tools_considered as string[] | null) ?? undefined,
    usage: (row.usage as RunSummary['usage']) ?? undefined,
  }));

  const total = Number(countResult.rows?.[0]?.total ?? 0);
  return { runs, total };
}

// ── Lineage: which runs touched an Adobe object ──────────────────────────

/** One run's change to an object, with enough of the run to link to it. */
export interface ObjectHistoryEntry extends LineageRecord {
  runId: string;
  runCreatedAt: string;
  runDescription: string;
  runStatus: RunSummary['status'];
}

/**
 * Every recorded change to the Adobe object with this id (optionally of one
 * kind), newest run first. Reads each run's lineage out of the existing
 * `result` JSONB (RunResult.lineage), so it needs no extra table; runs
 * stored before lineage was tracked simply have none.
 */
export async function findObjectHistory(opts: { id: string; kind?: string; limit?: number }): Promise<ObjectHistoryEntry[]> {
  await ensureTable();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const result = await execSql(
    `SELECT r.id AS run_id, r.created_at, r.description, r.status, e.value AS entry
       FROM ${TABLE} r, jsonb_array_elements(COALESCE(r.result->'lineage', '[]'::jsonb)) e
      WHERE e.value->'ref'->>'id' = ${sqlStr(opts.id)}
        ${opts.kind ? `AND e.value->'ref'->>'kind' = ${sqlStr(opts.kind)}` : ''}
      ORDER BY r.created_at DESC
      LIMIT ${sqlInt(limit)}`.replace(/\s+/g, ' ')
  );
  return (result.rows ?? []).map((row) => ({
    ...(row.entry as LineageRecord),
    runId: row.run_id as string,
    runCreatedAt: new Date(row.created_at as string).toISOString(),
    runDescription: row.description as string,
    runStatus: row.status as RunSummary['status'],
  }));
}
