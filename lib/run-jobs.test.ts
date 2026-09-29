import { describe, expect, it } from 'vitest';
import { cancelJob, getJob, startJob, streamJob } from './run-jobs';
import type { BuildStreamEvent } from './types';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A job whose execute() waits for `release()` before finishing. */
function controllableJob(id: string) {
  let emit!: (e: BuildStreamEvent) => void;
  let release!: () => void;
  const finished = new Promise<void>((r) => (release = r));
  const abort = new AbortController();
  const job = startJob(id, abort, async (e, signal) => {
    emit = e;
    await Promise.race([finished, new Promise((r) => signal.addEventListener('abort', r))]);
  });
  return { job, emit: (e: BuildStreamEvent) => emit(e), release, abort };
}

async function readAll(res: Response): Promise<Array<BuildStreamEvent & { seq: number }>> {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('run jobs', () => {
  it('sequences events, merges consecutive text deltas, and replays after a seq', async () => {
    const { job, emit, release } = controllableJob('j1');
    await tick();
    emit({ type: 'run_start', runId: 'j1', toolsConsidered: [] });
    emit({ type: 'text_delta', delta: 'Hel' });
    emit({ type: 'text_delta', delta: 'lo' });
    emit({ type: 'step', step: { stepNumber: 0, text: 'Hello', toolCalls: [], toolResults: [] } });
    expect(job.events.map((e) => e.type)).toEqual(['run_start', 'text_delta', 'step']);
    expect(job.events[1]).toMatchObject({ delta: 'Hello', seq: 3 });

    release();
    await tick();
    const replay = await readAll(streamJob(job, 1));
    expect(replay.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('streams live events to a subscriber and closes when the job finishes', async () => {
    const { job, emit, release } = controllableJob('j2');
    await tick();
    emit({ type: 'run_start', runId: 'j2', toolsConsidered: [] });
    const reading = readAll(streamJob(job));
    emit({ type: 'error', error: 'boom' });
    release();
    const events = await reading;
    expect(events.map((e) => e.type)).toEqual(['run_start', 'error']);
    expect(job.done).toBe(true);
  });

  it('keeps running when a stream is cancelled, and stops on cancelJob', async () => {
    const { job, emit } = controllableJob('j3');
    await tick();
    const res = streamJob(job);
    await res.body!.cancel();
    emit({ type: 'run_start', runId: 'j3', toolsConsidered: [] });
    expect(job.done).toBe(false);
    expect(job.listeners.size).toBe(0);

    expect(cancelJob('j3', 'Stopped by alice.')).toBe(true);
    expect((job.abort.signal.reason as Error).message).toBe('Stopped by alice.');
    await tick();
    expect(job.done).toBe(true);
    expect(cancelJob('j3', 'again')).toBe(false);
    expect(getJob('j3')).toBe(job); // still reconnectable for a while
  });

  it('caps the buffer, counting what it dropped', async () => {
    const { job, emit, release } = controllableJob('j4');
    await tick();
    for (let i = 0; i < 2_010; i++) emit({ type: 'restart', fromModelKey: 'a', toModelKey: String(i) });
    expect(job.events).toHaveLength(2_000);
    expect(job.dropped).toBe(10);
    release();
  });
});
