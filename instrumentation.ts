/**
 * Runs once per server start (Next.js instrumentation convention).
 *
 * Agent runs execute inside this process (lib/run-jobs.ts), so any run
 * still marked 'running' in the store belonged to a process that's gone:
 * mark it 'interrupted' so it shows as such and can be resumed. Done in the
 * background so a slow or unreachable database never delays startup.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { markInterruptedRuns } = await import('./lib/execution-store');
  markInterruptedRuns()
    .then((n) => {
      if (n > 0) console.warn(`[startup] Marked ${n} run(s) left running by a previous process as interrupted.`);
    })
    .catch((err) => console.error('[startup] Could not mark interrupted runs:', err instanceof Error ? err.message : err));
}
