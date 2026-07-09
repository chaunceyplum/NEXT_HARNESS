/**
 * Execution history / replayability.
 *
 * Every /api/build run (success or failure) is persisted here so it can be
 * listed and replayed from /results — not just msb_execute_solution's async
 * builds (those already have their own status polling via
 * app/executions/[id]), but every agent invocation.
 *
 * Storage is one JSON file per run under EXECUTION_STORE_DIR (default
 * .data/executions/<id>.json). This has zero setup cost — no database, no
 * extra credentials — but it does mean listing reads every file in the
 * directory (fine for a dev tool's worth of runs; if this grows into
 * thousands of executions or needs to survive a serverless/ephemeral
 * filesystem, swap this for a real table behind DATABASE_URL instead).
 *
 * Known harmless build warning: Turbopack's Node file-tracing flags this
 * module for doing runtime fs operations against a dynamic path. That's
 * intentional (it's a data directory, not a module import) and doesn't
 * affect correctness for a self-hosted/Node deployment; it would only
 * matter for serverless output bundling, which is another reason to
 * switch to DATABASE_URL before deploying there.
 */

import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { ExecutionRecord, RunSummary } from './types';

// turbopackIgnore: this is a runtime data directory, not a module path —
// tracing it as a build-time file dependency would pull the whole project
// into Next's output file tracing.
const STORE_DIR =
  process.env.EXECUTION_STORE_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.data', 'executions');

let ensureDirPromise: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!ensureDirPromise) {
    ensureDirPromise = mkdir(STORE_DIR, { recursive: true }).then(() => undefined);
  }
  return ensureDirPromise;
}

function filePathFor(id: string): string {
  return path.join(STORE_DIR, `${id}.json`);
}

export function newRunId(): string {
  return randomUUID();
}

export async function saveExecution(record: ExecutionRecord): Promise<void> {
  await ensureDir();
  await writeFile(filePathFor(record.id), JSON.stringify(record, null, 2), 'utf-8');
}

export async function getExecution(id: string): Promise<ExecutionRecord | null> {
  await ensureDir();
  try {
    const raw = await readFile(filePathFor(id), 'utf-8');
    return JSON.parse(raw) as ExecutionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface ListExecutionsOptions {
  limit?: number;
  offset?: number;
}

function toSummary(record: ExecutionRecord): RunSummary {
  return {
    id: record.id,
    createdAt: record.createdAt,
    description: record.description,
    model: record.model,
    allowFullBuild: record.allowFullBuild,
    status: record.status,
    durationMs: record.durationMs,
    toolsConsidered: record.toolsConsidered,
    executionId: record.executionId,
  };
}

/** Newest-first, paginated. */
export async function listExecutions(opts: ListExecutionsOptions = {}): Promise<{ runs: RunSummary[]; total: number }> {
  await ensureDir();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const files = (await readdir(STORE_DIR)).filter((f) => f.endsWith('.json'));
  const records = await Promise.all(
    files.map(async (f) => {
      try {
        return JSON.parse(await readFile(path.join(STORE_DIR, f), 'utf-8')) as ExecutionRecord;
      } catch {
        return null; // skip unreadable/corrupt files rather than failing the whole list
      }
    })
  );

  const summaries = records
    .filter((r): r is ExecutionRecord => r !== null)
    .map(toSummary)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return { runs: summaries.slice(offset, offset + limit), total: summaries.length };
}
