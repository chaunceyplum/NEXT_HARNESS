/**
 * Thin wrapper over the MCP server's `execute_sql` tool (full read/write/DDL
 * access to the server's own database, unlike the read-only query_rag_db) —
 * shared by every harness-owned table: lib/execution-store.ts
 * (harness_agent_runs) and lib/eval-store.ts (harness_eval_runs /
 * harness_eval_results).
 *
 * execute_sql takes a raw SQL string with no parameter binding, so every
 * value is escaped by hand with the sql* helpers below rather than using
 * placeholders — use them for every interpolated value, never raw template
 * strings.
 */

import { callMcpTool } from './mcp-client';

export interface ExecuteSqlResult {
  sql: string;
  returned_rows: boolean;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  count?: number;
  truncated?: boolean;
  rows_affected?: number;
  status?: string;
}

export async function execSql(sql: string): Promise<ExecuteSqlResult> {
  return (await callMcpTool('execute_sql', { sql })) as ExecuteSqlResult;
}

// ── SQL literal escaping (execute_sql has no parameter binding) ──────────

export function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlStrOrNull(value: string | null | undefined): string {
  return value == null ? 'NULL' : sqlStr(value);
}

export function sqlJson(value: unknown): string {
  return `${sqlStr(JSON.stringify(value))}::jsonb`;
}

export function sqlJsonOrNull(value: unknown): string {
  return value === undefined || value === null ? 'NULL' : sqlJson(value);
}

export function sqlBool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

export function sqlInt(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for SQL: ${value}`);
  return String(Math.trunc(value));
}

export function sqlIntOrNull(value: number | null | undefined): string {
  return value == null ? 'NULL' : sqlInt(value);
}
