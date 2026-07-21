/**
 * Execution history / replayability — backed by the MCP server's own
 * database via the `execute_sql` tool (full read/write/DDL access, unlike
 * the read-only query_rag_db), not local files.
 *
 * Two tables, both created/altered by ensureSchema() the first time this
 * module is used (idempotent — CREATE TABLE/ADD COLUMN/CREATE INDEX IF NOT
 * EXISTS), separate from the orchestrator's own `executions`/
 * `execution_resources`/`tool_invocations` tables (applied by
 * msb_run_migration) — those track msb_execute_solution's internal phase
 * state with a different schema and are owned by the Python backend;
 * writing into them directly would risk corrupting its own state machine.
 *
 *  - harness_agent_runs: one row per agent run. `saveExecution`/
 *    `getExecution`/`listExecutions` are the original end-of-run log API
 *    (still used by the /api/runs replay UI and the synchronous cutover
 *    path). `createRun`/`loadRun`/`checkpointStep` are the live counterpart
 *    used by the Step Functions Lambdas (aws/lambdas/) — same table, same
 *    row, checkpointed after every step instead of written once at the end.
 *  - harness_approvals: one row per human-approval gate. `taskToken` is a
 *    bearer credential (SendTaskSuccess/Failure don't support resource-level
 *    IAM scoping — possession of the token is the actual authorization), so
 *    it is never selected by listPendingApprovals() and never appears on
 *    ApprovalSummary.
 *
 * execute_sql takes a raw SQL string with no parameter binding, so every
 * value below is escaped by hand (sqlStr/sqlJson/etc.) rather than using
 * placeholders — see those helpers for exactly how.
 */

import { randomUUID } from 'crypto';
import { callMcpTool } from './mcp-client';
import type { ApprovalRecord, ApprovalSummary, ExecutionRecord, PendingToolCall, RunState, RunSummary } from './types';

const RUNS_TABLE = 'harness_agent_runs';
const APPROVALS_TABLE = 'harness_approvals';

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

/**
 * Postgres jsonb rejects the literal NUL byte, which arbitrary
 * user input or model/tool output can contain. JSON.stringify does not
 * escape it — it passes straight through — so it must be stripped here,
 * the one place every jsonb write goes through, or one poisoned message
 * wedges the run's every future checkpoint.
 */
function sqlJson(value: unknown): string {
  const json = JSON.stringify(value).replace(new RegExp(String.fromCharCode(0), 'g'), '');
  return `${sqlStr(json)}::jsonb`;
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

let ensureSchemaPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await execSql(
        `CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
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
      await execSql(`CREATE INDEX IF NOT EXISTS ${RUNS_TABLE}_created_at_idx ON ${RUNS_TABLE} (created_at DESC)`);

      // Step-Functions-loop columns — additive, so the original end-of-run
      // log API (saveExecution/getExecution/listExecutions) keeps working
      // unmodified against the same table.
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS selected_tools JSONB`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS step_count INT NOT NULL DEFAULT 0`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS sfn_execution_arn TEXT`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS msb_execution_id TEXT`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS pending_tool_calls JSONB`);
      await execSql(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
      await execSql(`CREATE INDEX IF NOT EXISTS idx_harness_runs_status ON ${RUNS_TABLE} (status)`);

      await execSql(
        `CREATE TABLE IF NOT EXISTS ${APPROVALS_TABLE} (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES ${RUNS_TABLE}(id),
          task_token TEXT NOT NULL,
          gated_calls JSONB NOT NULL,
          reasoning TEXT,
          status TEXT NOT NULL DEFAULT 'PENDING',
          feedback TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          resolved_at TIMESTAMPTZ
        )`.replace(/\s+/g, ' ')
      );
      await execSql(
        `CREATE INDEX IF NOT EXISTS idx_harness_approvals_pending ON ${APPROVALS_TABLE} (status) WHERE status = 'PENDING'`
      );
    })().catch((err) => {
      ensureSchemaPromise = null; // allow retry on next call
      throw err;
    });
  }
  return ensureSchemaPromise;
}

export function newRunId(): string {
  return randomUUID();
}

// ── Row <-> ExecutionRecord mapping (original end-of-run log API) ────────

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

// ── Original end-of-run log API (unchanged shape/behavior) ───────────────

export async function saveExecution(record: ExecutionRecord): Promise<void> {
  await ensureSchema();
  const sql = `
    INSERT INTO ${RUNS_TABLE}
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
  await ensureSchema();
  const result = await execSql(`SELECT * FROM ${RUNS_TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`);
  const row = result.rows?.[0];
  return row ? rowToRecord(row) : null;
}

export interface ListExecutionsOptions {
  limit?: number;
  offset?: number;
}

/** Newest-first, paginated. Excludes request/result/error (fetched in full via getExecution). */
export async function listExecutions(opts: ListExecutionsOptions = {}): Promise<{ runs: RunSummary[]; total: number }> {
  await ensureSchema();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const [listResult, countResult] = await Promise.all([
    execSql(
      `SELECT id, created_at, description, model, allow_full_build, status, duration_ms, tools_considered, execution_id
       FROM ${RUNS_TABLE} ORDER BY created_at DESC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}`.replace(/\s+/g, ' ')
    ),
    execSql(`SELECT count(*) AS total FROM ${RUNS_TABLE}`),
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

// ── Live checkpoint API (Step Functions loop) ─────────────────────────────

export interface CreateRunInit {
  id: string;
  description: string;
  model: string;
  allowFullBuild: boolean;
  selectedTools: RunState['selectedTools'];
  messages: unknown[];
  sfnExecutionArn?: string;
}

export async function createRun(init: CreateRunInit): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const request = { description: init.description, model: init.model, allowFullBuild: init.allowFullBuild };

  const sql = `
    INSERT INTO ${RUNS_TABLE}
      (id, created_at, description, model, allow_full_build, status, duration_ms, request,
       messages, selected_tools, step_count, sfn_execution_arn, updated_at)
    VALUES
      (${sqlStr(init.id)}, ${sqlStr(now)}, ${sqlStr(init.description)}, ${sqlStr(init.model)},
       ${sqlBool(init.allowFullBuild)}, ${sqlStr('RUNNING')}, ${sqlInt(0)}, ${sqlJson(request)},
       ${sqlJson(init.messages)}, ${sqlJson(init.selectedTools)}, ${sqlInt(0)},
       ${sqlStrOrNull(init.sfnExecutionArn)}, ${sqlStr(now)})
  `.replace(/\s+/g, ' ');

  await execSql(sql);
}

export async function loadRun(runId: string): Promise<RunState> {
  await ensureSchema();
  const result = await execSql(`SELECT * FROM ${RUNS_TABLE} WHERE id = ${sqlStr(runId)} LIMIT 1`);
  const row = result.rows?.[0];
  if (!row) throw new Error(`Run not found: ${runId}`);

  return {
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    description: row.description as string,
    model: row.model as string,
    allowFullBuild: row.allow_full_build as boolean,
    status: row.status as RunState['status'],
    messages: (row.messages as unknown[] | null) ?? [],
    selectedTools: (row.selected_tools as RunState['selectedTools'] | null) ?? [],
    stepCount: (row.step_count as number) ?? 0,
    pendingToolCalls: (row.pending_tool_calls as PendingToolCall[] | null) ?? null,
    msbExecutionId: (row.msb_execution_id as string | null) ?? null,
  };
}

export interface CheckpointStepPatch {
  newMessages: unknown[];
  pendingToolCalls?: PendingToolCall[] | null;
  status?: RunState['status'];
  stepCountDelta?: number;
  msbExecutionId?: string;
}

/**
 * Appends messages, updates pending calls/status/step count, in ONE
 * execute_sql UPDATE (messages = messages || new::jsonb is a jsonb array
 * concat, not an overwrite) so a crash mid-checkpoint can't leave messages
 * and pending_tool_calls out of sync with each other.
 */
export async function checkpointStep(runId: string, patch: CheckpointStepPatch): Promise<void> {
  await ensureSchema();

  const sets = [
    `messages = messages || ${sqlJson(patch.newMessages)}`,
    `updated_at = ${sqlStr(new Date().toISOString())}`,
  ];
  if (patch.pendingToolCalls !== undefined) {
    sets.push(`pending_tool_calls = ${sqlJsonOrNull(patch.pendingToolCalls)}`);
  }
  if (patch.status !== undefined) {
    sets.push(`status = ${sqlStr(patch.status)}`);
  }
  if (patch.stepCountDelta) {
    sets.push(`step_count = step_count + ${sqlInt(patch.stepCountDelta)}`);
  }
  if (patch.msbExecutionId !== undefined) {
    sets.push(`msb_execution_id = ${sqlStr(patch.msbExecutionId)}`);
  }

  const sql = `UPDATE ${RUNS_TABLE} SET ${sets.join(', ')} WHERE id = ${sqlStr(runId)}`.replace(/\s+/g, ' ');
  await execSql(sql);
}

export interface FinalizeRunPatch {
  status: RunState['status'];
  /** BuildResponse-shaped, built from deriveTraceFromMessages — keeps the /api/runs replay UI working unmodified. */
  result?: ExecutionRecord['result'];
  durationMs?: number;
  toolsConsidered?: string[];
  executionId?: string;
  error?: string;
}

/** Terminal write for a run — used by the finalize Lambda on all three exit paths (done, expired, failed). */
export async function finalizeRun(runId: string, patch: FinalizeRunPatch): Promise<void> {
  await ensureSchema();
  const sets = [`status = ${sqlStr(patch.status)}`, `updated_at = ${sqlStr(new Date().toISOString())}`];
  if (patch.result !== undefined) sets.push(`result = ${sqlJsonOrNull(patch.result)}`);
  if (patch.durationMs !== undefined) sets.push(`duration_ms = ${sqlInt(patch.durationMs)}`);
  if (patch.toolsConsidered !== undefined) sets.push(`tools_considered = ${sqlJsonOrNull(patch.toolsConsidered)}`);
  if (patch.executionId !== undefined) sets.push(`execution_id = ${sqlStrOrNull(patch.executionId)}`);
  if (patch.error !== undefined) sets.push(`error = ${sqlStrOrNull(patch.error)}`);
  const sql = `UPDATE ${RUNS_TABLE} SET ${sets.join(', ')} WHERE id = ${sqlStr(runId)}`.replace(/\s+/g, ' ');
  await execSql(sql);
}

// ── Approvals ──────────────────────────────────────────────────────────

function rowToApprovalSummary(row: Record<string, unknown>): ApprovalSummary {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    gatedCalls: (row.gated_calls as PendingToolCall[] | null) ?? [],
    reasoning: (row.reasoning as string | null) ?? '',
    status: row.status as ApprovalSummary['status'],
    feedback: (row.feedback as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : undefined,
  };
}

export interface CreateApprovalInit {
  id: string;
  runId: string;
  taskToken: string;
  gatedCalls: PendingToolCall[];
  reasoning: string;
}

export async function createApproval(a: CreateApprovalInit): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const sql = `
    INSERT INTO ${APPROVALS_TABLE} (id, run_id, task_token, gated_calls, reasoning, status, created_at)
    VALUES (${sqlStr(a.id)}, ${sqlStr(a.runId)}, ${sqlStr(a.taskToken)}, ${sqlJson(a.gatedCalls)}, ${sqlStrOrNull(a.reasoning)}, ${sqlStr('PENDING')}, ${sqlStr(now)})
  `.replace(/\s+/g, ' ');
  await execSql(sql);
}

/**
 * Includes task_token — server-side use only (resolving the approval via
 * SendTaskSuccess/Failure). Never forward this record to a client response;
 * use listPendingApprovals()/ApprovalSummary for anything client-facing.
 */
export async function loadApproval(id: string): Promise<ApprovalRecord> {
  await ensureSchema();
  const result = await execSql(`SELECT * FROM ${APPROVALS_TABLE} WHERE id = ${sqlStr(id)} LIMIT 1`);
  const row = result.rows?.[0];
  if (!row) throw new Error(`Approval not found: ${id}`);
  return { ...rowToApprovalSummary(row), taskToken: row.task_token as string };
}

export async function resolveApproval(id: string, status: 'APPROVED' | 'REJECTED', feedback?: string): Promise<void> {
  await ensureSchema();
  const sql = `
    UPDATE ${APPROVALS_TABLE}
    SET status = ${sqlStr(status)}, feedback = ${sqlStrOrNull(feedback)}, resolved_at = ${sqlStr(new Date().toISOString())}
    WHERE id = ${sqlStr(id)}
  `.replace(/\s+/g, ' ');
  await execSql(sql);
}

/** Never selects task_token — safe to return directly from GET /api/approvals. */
export async function listPendingApprovals(): Promise<ApprovalSummary[]> {
  await ensureSchema();
  const result = await execSql(
    `SELECT id, run_id, gated_calls, reasoning, status, feedback, created_at, resolved_at
     FROM ${APPROVALS_TABLE} WHERE status = 'PENDING' ORDER BY created_at ASC`.replace(/\s+/g, ' ')
  );
  return (result.rows ?? []).map(rowToApprovalSummary);
}
