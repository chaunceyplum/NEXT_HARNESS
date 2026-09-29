/**
 * Deployment memory (§3.5 memory: semantic memory with a deliberate write
 * path and a user-visible store): stable facts about this deployment that
 * save every run from rediscovering them, such as which sandbox is
 * production, the Launch property id, and the repo tags live in.
 *
 *   Write: the agent calls remember_fact(key, value) when it learns a stable
 *          identifier worth reusing. Values are short, one per key, never
 *          credentials or personal data, and people can edit or delete them.
 *   Read:  each run starts with the stored facts in its first message (not
 *          the system prompt, so the cached prompt prefix stays stable),
 *          marked as possibly stale.
 *
 * Stored in harness_memory (MCP server Postgres via execute_sql). MEMORY_ENABLED=false
 * turns both paths off. Read failures never block a run.
 */

import { execSql, sqlStr, sqlStrOrNull } from './mcp-sql';
import { findPii, findSecrets } from './llm/guardrails';

const TABLE = 'harness_memory';
export const MAX_FACTS = 100;
const MAX_VALUE_CHARS = 300;
const KEY_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export interface MemoryFact {
  key: string;
  value: string;
  note?: string;
  sourceRunId?: string;
  updatedBy: string;
  updatedAt: string;
}

export function memoryEnabled(): boolean {
  return process.env.MEMORY_ENABLED?.trim().toLowerCase() !== 'false';
}

let ensureTablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = execSql(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        note TEXT,
        source_run_id TEXT,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`.replace(/\s+/g, ' ')
    )
      .then(() => undefined)
      .catch((err) => {
        ensureTablePromise = null;
        throw err;
      });
  }
  return ensureTablePromise;
}

/** Why a fact can't be stored, or undefined if it can. */
export function validateFact(key: string, value: string): string | undefined {
  if (!KEY_RE.test(key)) return 'key must be 2-64 chars: lowercase letters, digits, "_", "." or "-", starting with a letter (e.g. "aep.prod_sandbox")';
  if (!value.trim()) return 'value is empty';
  if (value.length > MAX_VALUE_CHARS) return `value is longer than ${MAX_VALUE_CHARS} characters; store an identifier, not a document`;
  if (findSecrets(`${key} ${value}`).length) return 'looks like a credential; credentials are never stored in memory';
  if (findPii(value).length) return 'contains personal data; memory is for deployment facts, not people';
  return undefined;
}

function rowToFact(row: Record<string, unknown>): MemoryFact {
  return {
    key: row.key as string,
    value: row.value as string,
    note: (row.note as string | null) ?? undefined,
    sourceRunId: (row.source_run_id as string | null) ?? undefined,
    updatedBy: row.updated_by as string,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listFacts(): Promise<MemoryFact[]> {
  await ensureTable();
  const result = await execSql(`SELECT * FROM ${TABLE} ORDER BY key LIMIT ${MAX_FACTS}`);
  return (result.rows ?? []).map(rowToFact);
}

export async function countFacts(): Promise<number> {
  await ensureTable();
  const result = await execSql(`SELECT count(*) AS n FROM ${TABLE}`);
  return Number(result.rows?.[0]?.n ?? 0);
}

/** Insert or replace one fact. Throws with the reason if it's not storable. */
export async function saveFact(fact: { key: string; value: string; note?: string; sourceRunId?: string; updatedBy: string }): Promise<MemoryFact> {
  const key = fact.key.trim().toLowerCase();
  const value = fact.value.trim();
  const problem = validateFact(key, value);
  if (problem) throw new Error(`Not stored: ${problem}.`);
  await ensureTable();
  const existing = await execSql(`SELECT 1 FROM ${TABLE} WHERE key = ${sqlStr(key)}`);
  if (!existing.rows?.length && (await countFacts()) >= MAX_FACTS) {
    throw new Error(`Not stored: memory is full (${MAX_FACTS} facts). Remove some on the /memory page.`);
  }
  const result = await execSql(
    `INSERT INTO ${TABLE} (key, value, note, source_run_id, updated_by, updated_at)
     VALUES (${sqlStr(key)}, ${sqlStr(value)}, ${sqlStrOrNull(fact.note?.slice(0, 300))}, ${sqlStrOrNull(fact.sourceRunId)}, ${sqlStr(fact.updatedBy)}, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note, source_run_id = EXCLUDED.source_run_id,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
     RETURNING *`.replace(/\s+/g, ' ')
  );
  return rowToFact(result.rows?.[0] ?? { ...fact, key, value, updated_by: fact.updatedBy, updated_at: new Date().toISOString() });
}

export async function deleteFact(key: string): Promise<boolean> {
  await ensureTable();
  const result = await execSql(`DELETE FROM ${TABLE} WHERE key = ${sqlStr(key)} RETURNING key`);
  return Boolean(result.rows?.length);
}

/** The block prepended to a run's first message, or '' when there's nothing to say. */
export function memoryPreamble(facts: MemoryFact[]): string {
  if (facts.length === 0) return '';
  return [
    'Known facts about this deployment, from memory (saved by earlier runs or edited by people; they may be out of date, so verify anything a change depends on):',
    ...facts.map((f) => `- ${f.key}: ${f.value}`),
    '',
  ].join('\n');
}
