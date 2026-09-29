/**
 * Audit log: who triggered each consequential agent action, what it did,
 * and how it turned out. The guide's "incident response foundation" (§6.4).
 *
 * Stored in harness_audit_log in the MCP server's Postgres (via execute_sql,
 * like lib/execution-store.ts). Rows are only ever inserted; nothing here
 * updates or deletes them.
 *
 * What's recorded:
 *   tool_call   every write/destructive tool call the agent made (and reads,
 *               with AUDIT_READS=true): effective tool (call_tool unwrapped),
 *               redacted + truncated input, outcome ok/error/denied, error
 *   approval    every approve/deny decision, with who made it
 *   run_start   who started a run and the (redacted) request
 *   kill_switch engage/release, with who and why
 *
 * Writes are best-effort: a failed insert is logged and never breaks a run.
 */

import { randomUUID } from 'crypto';
import { execSql, sqlInt, sqlJsonOrNull, sqlStr, sqlStrOrNull } from './mcp-sql';
import { redactOutput } from './llm/guardrails';

const TABLE = 'harness_audit_log';
const MAX_INPUT_CHARS = 4_000;

export type AuditEventType = 'run_start' | 'tool_call' | 'approval' | 'kill_switch';
export type AuditOutcome = 'ok' | 'error' | 'denied' | 'approved' | 'engaged' | 'released';

export interface AuditEvent {
  type: AuditEventType;
  runId?: string;
  /** The authenticated user who started the run, or who acted (approval, kill switch). */
  actor: string;
  tool?: string;
  /** read / write / destructive (lib/llm/tool-policy.ts). */
  level?: string;
  /** Why a call needed approval (lib/llm/approval-policy.ts), when it did. */
  reason?: string;
  input?: unknown;
  outcome?: AuditOutcome;
  error?: string;
  /** Epoch ms; defaults to when the event is recorded. */
  at?: number;
}

export interface AuditRow extends Omit<AuditEvent, 'at'> {
  id: string;
  at: string;
}

let ensureTablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await execSql(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
          id TEXT PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          run_id TEXT,
          actor TEXT NOT NULL,
          tool TEXT,
          level TEXT,
          reason TEXT,
          input JSONB,
          outcome TEXT,
          error TEXT
        )`.replace(/\s+/g, ' ')
      );
      await execSql(`CREATE INDEX IF NOT EXISTS ${TABLE}_at_idx ON ${TABLE} (at DESC)`);
      await execSql(`CREATE INDEX IF NOT EXISTS ${TABLE}_run_idx ON ${TABLE} (run_id)`);
    })().catch((err) => {
      ensureTablePromise = null;
      throw err;
    });
  }
  return ensureTablePromise;
}

/** Redact credentials and cap size, so the log never becomes the leak. */
export function auditInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  const redacted = redactOutput(input);
  const json = JSON.stringify(redacted) ?? '';
  return json.length <= MAX_INPUT_CHARS ? redacted : { _truncated: true, preview: json.slice(0, MAX_INPUT_CHARS) };
}

export function auditReads(): boolean {
  return process.env.AUDIT_READS?.trim().toLowerCase() === 'true';
}

function valuesRow(e: AuditEvent): string {
  return `(${[
    sqlStr(randomUUID()),
    sqlStr(new Date(e.at ?? Date.now()).toISOString()),
    sqlStr(e.type),
    sqlStrOrNull(e.runId),
    sqlStr(e.actor),
    sqlStrOrNull(e.tool),
    sqlStrOrNull(e.level),
    sqlStrOrNull(e.reason),
    sqlJsonOrNull(auditInput(e.input)),
    sqlStrOrNull(e.outcome),
    sqlStrOrNull(e.error ? redactOutput(e.error).slice(0, 2_000) : undefined),
  ].join(', ')})`;
}

/** Insert events in one statement. Never throws; failures are logged. */
export async function recordAudit(events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await ensureTable();
    await execSql(
      `INSERT INTO ${TABLE} (id, at, type, run_id, actor, tool, level, reason, input, outcome, error) VALUES ${events
        .map(valuesRow)
        .join(', ')}`
    );
  } catch (err) {
    console.error(`[audit] Failed to record ${events.length} event(s):`, err instanceof Error ? err.message : err);
  }
}

export interface AuditQuery {
  runId?: string;
  actor?: string;
  tool?: string;
  type?: AuditEventType;
  limit?: number;
  offset?: number;
}

export async function listAudit(q: AuditQuery = {}): Promise<AuditRow[]> {
  await ensureTable();
  const where = [
    q.runId ? `run_id = ${sqlStr(q.runId)}` : null,
    q.actor ? `actor = ${sqlStr(q.actor)}` : null,
    q.tool ? `tool = ${sqlStr(q.tool)}` : null,
    q.type ? `type = ${sqlStr(q.type)}` : null,
  ].filter(Boolean);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const result = await execSql(
    `SELECT * FROM ${TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(q.offset ?? 0)}`
  );
  return (result.rows ?? []).map((row) => ({
    id: row.id as string,
    at: new Date(row.at as string).toISOString(),
    type: row.type as AuditEventType,
    runId: (row.run_id as string | null) ?? undefined,
    actor: row.actor as string,
    tool: (row.tool as string | null) ?? undefined,
    level: (row.level as string | null) ?? undefined,
    reason: (row.reason as string | null) ?? undefined,
    input: row.input ?? undefined,
    outcome: (row.outcome as AuditOutcome | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
  }));
}
