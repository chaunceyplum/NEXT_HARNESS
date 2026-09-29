/**
 * Runs as jobs, not as HTTP requests (§6.1, §6.2).
 *
 * An agent run used to live inside its POST /api/build response: closing
 * the tab, a proxy timeout or a dropped connection aborted it mid-run,
 * possibly between two writes. Now the run executes detached in this
 * process, and every event it emits is buffered on its job, so:
 *
 *   - POST /api/build starts the job and streams its events, as before
 *   - a client that disconnects doesn't stop the run; it can reconnect with
 *     GET /api/runs/:id/events (buffered events replay, then live ones)
 *   - stopping is explicit: POST /api/runs/:id/cancel, the kill switch, or
 *     the run's own limits
 *
 * Finished jobs stay reconnectable for RETAIN_MS, then only the persisted
 * record (lib/execution-store.ts) remains. Like approvals and the kill
 * switch, this assumes one Node process; state lives on globalThis so
 * dev-mode module reloading doesn't split it between route bundles.
 */

import type { BuildStreamEvent } from './types';

const RETAIN_MS = 15 * 60_000;
/** Buffered events per run. Consecutive text deltas are merged, so this is mostly steps and approvals. */
const MAX_EVENTS = 2_000;

export type SequencedEvent = BuildStreamEvent & { seq: number };
type Listener = (event: SequencedEvent | null) => void;

export interface RunJob {
  runId: string;
  abort: AbortController;
  events: SequencedEvent[];
  /** Events dropped from the front of the buffer once it passed MAX_EVENTS. */
  dropped: number;
  done: boolean;
  startedAt: number;
  listeners: Set<Listener>;
}

const jobs: Map<string, RunJob> = ((globalThis as { __harnessRunJobs?: Map<string, RunJob> }).__harnessRunJobs ??= new Map());

export function getJob(runId: string): RunJob | undefined {
  return jobs.get(runId);
}

export function activeJobCount(): number {
  return [...jobs.values()].filter((j) => !j.done).length;
}

/**
 * Start `execute` detached from any request. It receives `emit` for its
 * events and the job's abort signal. The job is done when `execute`
 * settles; `execute` should handle its own errors (emit an error event).
 */
export function startJob(
  runId: string,
  abort: AbortController,
  execute: (emit: (event: BuildStreamEvent) => void, signal: AbortSignal) => Promise<void>
): RunJob {
  const job: RunJob = { runId, abort, events: [], dropped: 0, done: false, startedAt: Date.now(), listeners: new Set() };
  jobs.set(runId, job);
  let seq = 0;

  const emit = (event: BuildStreamEvent) => {
    if (job.done) return;
    const sequenced = { ...event, seq: ++seq } as SequencedEvent;
    const last = job.events[job.events.length - 1];
    if (event.type === 'text_delta' && last?.type === 'text_delta') {
      // Merge into the buffered delta so long answers don't flood the buffer.
      job.events[job.events.length - 1] = { ...last, delta: last.delta + event.delta, seq: sequenced.seq };
    } else {
      job.events.push(sequenced);
      if (job.events.length > MAX_EVENTS) {
        job.events.shift();
        job.dropped++;
      }
    }
    for (const listener of job.listeners) listener(sequenced);
  };

  void (async () => {
    try {
      await execute(emit, abort.signal);
    } catch (err) {
      console.error(`[run-jobs] Run ${runId} threw outside its own error handling:`, err);
    } finally {
      job.done = true;
      for (const listener of job.listeners) listener(null);
      job.listeners.clear();
      setTimeout(() => {
        if (jobs.get(runId) === job) jobs.delete(runId);
      }, RETAIN_MS).unref?.();
    }
  })();

  return job;
}

/** Abort a running job. Returns false if it's unknown or already done. */
export function cancelJob(runId: string, reason: string): boolean {
  const job = jobs.get(runId);
  if (!job || job.done) return false;
  job.abort.abort(new Error(reason));
  return true;
}

/**
 * NDJSON stream of a job's events: the buffered ones with seq > `after`,
 * then live ones until the job finishes. Closing the stream only
 * unsubscribes; the run keeps going.
 */
export function streamJob(job: RunJob, after = 0): Response {
  const enc = new TextEncoder();
  let listener: Listener | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const write = (event: SequencedEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(event) + '\n'));
        } catch {
          /* client went away */
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      for (const event of job.events) if (event.seq > after) write(event);
      if (job.done) return close();
      listener = (event) => (event ? write(event) : close());
      job.listeners.add(listener);
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Run-Id': job.runId,
    },
  });
}
