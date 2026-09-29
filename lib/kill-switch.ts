/**
 * Kill switch: stop every agent run in this process within seconds, and
 * refuse new ones until it's released.
 *
 * Two ways to engage it:
 *   - AGENT_DISABLED=true in the environment: durable across restarts;
 *     can't be released from the UI.
 *   - POST /api/admin/kill-switch {"engaged":true}: immediate, aborts the
 *     runs in flight; lives in this process's memory, so a restart
 *     releases it (a restart also ends every run, so nothing resumes).
 *
 * Active runs register their AbortController here, which is also how the
 * switch reaches them. Kept on globalThis so Next's dev-mode module
 * reloading doesn't split the state between route bundles, as in
 * lib/llm/approvals.ts.
 */

interface ActiveRun {
  abort: AbortController;
  startedAt: number;
  user: string;
  description: string;
}

interface KillSwitchState {
  runs: Map<string, ActiveRun>;
  engaged?: { at: string; by: string; reason: string };
}

const state: KillSwitchState = ((globalThis as { __harnessKillSwitch?: KillSwitchState }).__harnessKillSwitch ??= {
  runs: new Map(),
});

function envDisabled(): boolean {
  return process.env.AGENT_DISABLED?.trim().toLowerCase() === 'true';
}

export interface KillSwitchStatus {
  engaged: boolean;
  /** 'env' when AGENT_DISABLED is set (can't be released here), 'runtime' when engaged via the API. */
  source?: 'env' | 'runtime';
  at?: string;
  by?: string;
  reason?: string;
  activeRuns: Array<{ runId: string; startedAt: string; user: string; description: string }>;
}

export function killSwitchStatus(): KillSwitchStatus {
  const activeRuns = [...state.runs.entries()].map(([runId, r]) => ({
    runId,
    startedAt: new Date(r.startedAt).toISOString(),
    user: r.user,
    description: r.description.slice(0, 120),
  }));
  if (envDisabled()) return { engaged: true, source: 'env', reason: 'AGENT_DISABLED=true', activeRuns };
  if (state.engaged) return { engaged: true, source: 'runtime', ...state.engaged, activeRuns };
  return { engaged: false, activeRuns };
}

/** Why new runs are refused right now, or undefined if they're allowed. */
export function runsBlockedReason(): string | undefined {
  const s = killSwitchStatus();
  if (!s.engaged) return undefined;
  return s.source === 'env'
    ? 'The agent is disabled for this deployment (AGENT_DISABLED=true).'
    : `The agent kill switch was engaged by ${s.by} at ${s.at}${s.reason ? ` (${s.reason})` : ''}.`;
}

/** Track a run so the kill switch can abort it. Returns the unregister function. */
export function registerRun(runId: string, run: ActiveRun): () => void {
  state.runs.set(runId, run);
  return () => {
    state.runs.delete(runId);
  };
}

/** Engage: refuse new runs and abort every active one. Returns how many runs were aborted. */
export function engageKillSwitch(by: string, reason = ''): number {
  state.engaged = { at: new Date().toISOString(), by, reason };
  let aborted = 0;
  for (const run of state.runs.values()) {
    if (!run.abort.signal.aborted) {
      run.abort.abort(new Error(`Stopped by the kill switch (${by}${reason ? `: ${reason}` : ''}).`));
      aborted++;
    }
  }
  return aborted;
}

export function releaseKillSwitch(): void {
  state.engaged = undefined;
}
