/**
 * Process-wide cap on how many agent loops run at once (Requirement 13.1,
 * 13.2).
 *
 * Every worker and every single-agent run goes through `executeLoop`. Each
 * one acquires a slot here before its first model call and releases it when
 * the loop ends, fails or is aborted. With orchestration on, one run can
 * spawn several workers, so the number of live loops is no longer bounded by
 * the number of runs — `MAX_AGENT_LOOPS` (default 12) is the real ceiling on
 * concurrent model work in this process, protecting it and the upstream
 * provider's rate limits.
 *
 * The semaphore is FIFO: callers that can't get a slot queue in arrival
 * order and are served in that order as slots free up. State lives on
 * `globalThis` (same pattern as `lib/run-jobs.ts`, approvals and the kill
 * switch) so dev-mode module reloading doesn't split it across route
 * bundles. The whole app is one Node process by design.
 *
 * An abort while queued removes the waiter from the queue and rejects its
 * acquire promise, so a cancelled run never holds a place in line.
 */

const DEFAULT_MAX_AGENT_LOOPS = 12;

/** `MAX_AGENT_LOOPS` from the environment (default 12, minimum 1). */
export function maxAgentLoops(): number {
  const raw = process.env.MAX_AGENT_LOOPS?.trim();
  if (!raw) return DEFAULT_MAX_AGENT_LOOPS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_AGENT_LOOPS;
}

interface Waiter {
  /** Hand a slot to this waiter. */
  grant: () => void;
  /** Reject this waiter (abort while queued). */
  reject: (err: unknown) => void;
  /** Detaches the abort listener, if any. */
  cleanup: () => void;
}

interface SlotState {
  running: number;
  queue: Waiter[];
}

const state: SlotState = ((globalThis as { __harnessAgentSlots?: SlotState }).__harnessAgentSlots ??= {
  running: 0,
  queue: [],
});

/**
 * Acquire one loop slot. Resolves with a `release()` to call exactly once
 * when the loop settles (success, error or abort). If no slot is free the
 * caller queues FIFO; if `signal` aborts while queued, the returned promise
 * rejects with the signal's reason and the waiter is removed from the queue.
 *
 * `release()` is idempotent — calling it more than once is a no-op — so a
 * `finally` block can release without tracking whether an earlier path
 * already did.
 */
export function acquireLoopSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };

  if (state.running < maxAgentLoops()) {
    state.running++;
    return Promise.resolve(makeRelease());
  }

  return new Promise<() => void>((resolve, reject) => {
    const onAbort = () => {
      const i = state.queue.indexOf(waiter);
      if (i !== -1) state.queue.splice(i, 1);
      waiter.cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    const waiter: Waiter = {
      // Called from releaseSlot, which has already kept the slot occupied on
      // this waiter's behalf (it never decremented `running`), so grant must
      // NOT increment again.
      grant: () => {
        waiter.cleanup();
        resolve(makeRelease());
      },
      reject: (err) => {
        waiter.cleanup();
        reject(err);
      },
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    };
    signal?.addEventListener('abort', onAbort);
    state.queue.push(waiter);
  });
}

/**
 * Give up one running slot. If a waiter is queued, the slot passes straight
 * to it (so `running` stays the same — one loop ended, one begins);
 * otherwise `running` drops by one.
 */
function releaseSlot(): void {
  const next = state.queue.shift();
  if (next) {
    next.grant();
  } else if (state.running > 0) {
    state.running--;
  }
}

/** Snapshot for diagnostics and tests. */
export function loopSlotStats(): { running: number; queued: number; max: number } {
  return { running: state.running, queued: state.queue.length, max: maxAgentLoops() };
}
