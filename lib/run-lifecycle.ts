/**
 * The run lifecycle: every status a run record can have, and the moves
 * between them. The run store, the job runner, the resume route, metrics and
 * the UI all read run status through this module.
 *
 *                 ┌──────────── awaiting_approval ◄──┐
 *                 │                  │               │
 *                 ▼   (all decided)  │ (a call or    │
 *   (start) ──► running ◄────────────┘  the plan     │
 *                 │   ─────────────────────waits)────┘
 *                 ├──► completed     the agent finished
 *                 ├──► failed        an error ended the run
 *                 ├──► cancelled     stopped by a person or the kill switch
 *                 └──► interrupted   the server stopped mid-run (set on the next start)
 *
 * awaiting_approval can also end in failed, cancelled or interrupted.
 * Every end state is final for that record: resuming a failed, cancelled or
 * interrupted run starts a NEW run (resumedFrom), it does not reopen this one.
 */

export const RUN_STATUSES = ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  running: ['awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

/** Statuses of a run that is still going in some process. */
export const ACTIVE_STATUSES: readonly RunStatus[] = ['running', 'awaiting_approval'];

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The new status, or an error naming the illegal move. */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) throw new Error(`Illegal run status change: ${from} -> ${to}`);
  return to;
}

/** Still going: running, or paused on a person. */
export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** No further changes to this record. */
export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Can be continued by a new run (POST /api/runs/:id/resume). */
export function isResumable(status: RunStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

/** How a run that threw ends: cancelled when its abort signal fired, failed otherwise. */
export function endStatusOnError(cancelled: boolean): 'failed' | 'cancelled' {
  return cancelled ? 'cancelled' : 'failed';
}
