/**
 * Per-run quality signals from production, the guide's "online" eval level
 * (§5.2): user feedback (👍/👎 + comment) and a sampled LLM-judge grade.
 *
 * Kept in its own table, harness_run_quality, keyed by run id, so the run
 * table's schema is untouched and both signals can arrive after the run is
 * persisted, in either order.
 */

import { execSql, sqlInt, sqlJsonOrNull, sqlStr, sqlStrOrNull } from './mcp-sql';

const TABLE = 'harness_run_quality';

export interface RunQuality {
  runId: string;
  /** 1 = 👍, -1 = 👎. */
  rating?: 1 | -1;
  comment?: string;
  ratedBy?: string;
  ratedAt?: string;
  judgePass?: boolean;
  judgeScores?: unknown;
  judgeNotes?: string;
  judgedBy?: string;
  judgedAt?: string;
}

let ensureTablePromise: Promise<void> | null = null;

export function ensureQualityTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = execSql(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        run_id TEXT PRIMARY KEY,
        rating INTEGER,
        comment TEXT,
        rated_by TEXT,
        rated_at TIMESTAMPTZ,
        judge_pass BOOLEAN,
        judge_scores JSONB,
        judge_notes TEXT,
        judged_by TEXT,
        judged_at TIMESTAMPTZ
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

export async function saveFeedback(runId: string, rating: 1 | -1, comment: string | undefined, user: string): Promise<void> {
  await ensureQualityTable();
  await execSql(
    `INSERT INTO ${TABLE} (run_id, rating, comment, rated_by, rated_at)
     VALUES (${sqlStr(runId)}, ${sqlInt(rating)}, ${sqlStrOrNull(comment)}, ${sqlStr(user)}, now())
     ON CONFLICT (run_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment,
       rated_by = EXCLUDED.rated_by, rated_at = EXCLUDED.rated_at`.replace(/\s+/g, ' ')
  );
}

export async function saveJudgment(
  runId: string,
  j: { pass: boolean; scores: unknown; notes: string; judgedBy: string }
): Promise<void> {
  await ensureQualityTable();
  await execSql(
    `INSERT INTO ${TABLE} (run_id, judge_pass, judge_scores, judge_notes, judged_by, judged_at)
     VALUES (${sqlStr(runId)}, ${j.pass ? 'TRUE' : 'FALSE'}, ${sqlJsonOrNull(j.scores)}, ${sqlStrOrNull(j.notes)}, ${sqlStr(j.judgedBy)}, now())
     ON CONFLICT (run_id) DO UPDATE SET judge_pass = EXCLUDED.judge_pass, judge_scores = EXCLUDED.judge_scores,
       judge_notes = EXCLUDED.judge_notes, judged_by = EXCLUDED.judged_by, judged_at = EXCLUDED.judged_at`.replace(/\s+/g, ' ')
  );
}

export async function getQuality(runId: string): Promise<RunQuality | null> {
  await ensureQualityTable();
  const row = (await execSql(`SELECT * FROM ${TABLE} WHERE run_id = ${sqlStr(runId)} LIMIT 1`)).rows?.[0];
  if (!row) return null;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
  return {
    runId,
    rating: (row.rating as 1 | -1 | null) ?? undefined,
    comment: (row.comment as string | null) ?? undefined,
    ratedBy: (row.rated_by as string | null) ?? undefined,
    ratedAt: iso(row.rated_at),
    judgePass: (row.judge_pass as boolean | null) ?? undefined,
    judgeScores: row.judge_scores ?? undefined,
    judgeNotes: (row.judge_notes as string | null) ?? undefined,
    judgedBy: (row.judged_by as string | null) ?? undefined,
    judgedAt: iso(row.judged_at),
  };
}

