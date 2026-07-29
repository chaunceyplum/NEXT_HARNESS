/**
 * Execution history / replayability — backed by the MCP server's own
 * database via the `execute_sql` tool (full read/write/DDL access, unlike
 * the read-only query_rag_db), not local files.
 *
 * Table: harness_agent_runs, created by ensureTable() the first time this
 * module is used (idempotent — CREATE TABLE/INDEX IF NOT EXISTS). This is
 * a table dedicated to the harness, separate from the orchestrator's own
 * `executions`/`execution_resources`/`tool_invocations` tables (applied by
 * msb_run_migration) — those track msb_execute_solution's internal phase
 * state with a different schema (execution_id/client_name/config/
 * current_phase/phase_results) and are owned by the Python backend; writing
 * into them directly would risk corrupting its own state machine.
 *
 * execute_sql takes a raw SQL string with no parameter binding, so every
 * value below is escaped by hand (sqlStr/sqlJson/etc.) rather than using
 * placeholders — see those helpers for exactly how.
 */

import { randomUUID } from 'crypto';
import { callMcpTool } from './mcp-client';
import type { ExecutionRecord, RunSummary } from './types';

const TABLE = 'harness_agent_runs';

interface ExecuteSqlResult {
  sql: string;
  returned_rows: boolean;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  count?: number;
  truncated?: boolean;
  rows_affected?: number;
  status?: string;
}

async function execSql(sql: string): Promise<ExecuteSqlResult> {
  return (await callMcpTool('execute_sql', { sql })) as ExecuteSqlResult;
}

// ── SQL literal escaping (execute_sql has no parameter binding) ──────────

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlStrOrNull(value: string | null | undefined): string {
  return value == null ? 'NULL' : sqlStr(value);
}

function sqlJson(value: unknown): string {
  return `${sqlStr(JSON.stringify(value))}::jsonb`;
}

function sqlJsonOrNull(value: unknown): string {
  return value === undefined || value === null ? 'NULL' : sqlJson(value);
}

function sqlBool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function sqlInt(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for SQL: ${value}`);
  return String(Math.trunc(value));
}

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

export function newRunId(): string {
  return randomUUID();
}

// ── Row <-> ExecutionRecord mapping ───────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    allowFullBuild: row.allow_full_build as boolean,
    status: row.status as ExecutionRecord['status'],
    durationMs: row.duration_ms as number,
    toolsConsidered: (row.tools_considered as string[] | null) ?? undefined,
    executionId: (row.execution_id as string | null) ?? undefined,
    request: row.request as ExecutionRecord['request'],
    result: (row.result as ExecutionRecord['result'] | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
  };
}

// ── Public API (same shape as the old file-based store) ──────────────────

export async function saveExecution(record: ExecutionRecord): Promise<void> {
  await ensureTable();
  const sql = `
    INSERT INTO ${TABLE}
      (id, created_at, description, model, allow_full_build, status, duration_ms, tools_considered, execution_id, request, result, error)
    VALUES
      (${sqlStr(record.id)}, ${sqlStr(record.createdAt)}, ${sqlStr(record.description)}, ${sqlStr(record.model)},
       ${sqlBool(record.allowFullBuild)}, ${sqlStr(record.status)}, ${sqlInt(record.durationMs)},
       ${sqlJsonOrNull(record.toolsConsidered)}, ${sqlStrOrNull(record.executionId)},
       ${sqlJson(record.request)}, ${sqlJsonOrNull(record.result)}, ${sqlStrOrNull(record.error)})
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      duration_ms = EXCLUDED.duration_ms,
      tools_considered = EXCLUDED.tools_considered,
      execution_id = EXCLUDED.execution_id,
      result = EXCLUDED.result,
      error = EXCLUDED.error
  `.replace(/\s+/g, ' ');

  await execSql(sql);
}

export async function getExecution(id: string): Promise<ExecutionRecord | null> {
  await ensureTable();
  const result = await execSql(`SELECT * FROM ${TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`);
  const row = result.rows?.[0];
  return row ? rowToRecord(row) : null;
}

export interface ListExecutionsOptions {
  limit?: number;
  offset?: number;
}

/** Newest-first, paginated. Excludes request/result/error (fetched in full via getExecution). */
export async function listExecutions(opts: ListExecutionsOptions = {}): Promise<{ runs: RunSummary[]; total: number }> {
  await ensureTable();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const [listResult, countResult] = await Promise.all([
    execSql(
      `SELECT id, created_at, description, model, allow_full_build, status, duration_ms, tools_considered, execution_id
       FROM ${TABLE} ORDER BY created_at DESC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}`.replace(/\s+/g, ' ')
    ),
    execSql(`SELECT count(*) AS total FROM ${TABLE}`),
  ]);

  const runs: RunSummary[] = (listResult.rows ?? []).map((row) => ({
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    allowFullBuild: row.allow_full_build as boolean,
    status: row.status as RunSummary['status'],
    durationMs: row.duration_ms as number,
    toolsConsidered: (row.tools_considered as string[] | null) ?? undefined,
    executionId: (row.execution_id as string | null) ?? undefined,
  }));

  const total = Number(countResult.rows?.[0]?.total ?? 0);
  return { runs, total };
}
