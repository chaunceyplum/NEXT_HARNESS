import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLoopSlot, loopSlotStats, maxAgentLoops } from './agent-slots';

// The semaphore lives on globalThis so it survives dev-mode module reloads.
// Each test drains it back to empty and restores MAX_AGENT_LOOPS.
const original = process.env.MAX_AGENT_LOOPS;

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  process.env.MAX_AGENT_LOOPS = '2';
});

afterEach(() => {
  // Each test releases everything it holds, so the semaphore should be idle.
  // Assert it to catch a leak before it corrupts the next test.
  expect(loopSlotStats()).toMatchObject({ running: 0, queued: 0 });
  if (original === undefined) delete process.env.MAX_AGENT_LOOPS;
  else process.env.MAX_AGENT_LOOPS = original;
});

describe('maxAgentLoops', () => {
  it('defaults to 12 and reads the env var', () => {
    delete process.env.MAX_AGENT_LOOPS;
    expect(maxAgentLoops()).toBe(12);
    process.env.MAX_AGENT_LOOPS = '5';
    expect(maxAgentLoops()).toBe(5);
    process.env.MAX_AGENT_LOOPS = 'nonsense';
    expect(maxAgentLoops()).toBe(12);
  });
});

describe('acquireLoopSlot', () => {
  it('hands out up to MAX_AGENT_LOOPS slots immediately, then queues', async () => {
    const r1 = await acquireLoopSlot();
    const r2 = await acquireLoopSlot();
    expect(loopSlotStats()).toMatchObject({ running: 2, queued: 0, max: 2 });

    let third: (() => void) | undefined;
    const p3 = acquireLoopSlot().then((r) => (third = r));
    await tick();
    expect(loopSlotStats()).toMatchObject({ running: 2, queued: 1 });
    expect(third).toBeUndefined();

    r1();
    await p3;
    expect(third).toBeDefined();
    expect(loopSlotStats()).toMatchObject({ running: 2, queued: 0 });

    r2();
    third!();
    expect(loopSlotStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('serves queued waiters in FIFO order', async () => {
    const held1 = await acquireLoopSlot();
    const held2 = await acquireLoopSlot();

    const order: number[] = [];
    const releases: Array<() => void> = [];
    const w1 = acquireLoopSlot().then((r) => { order.push(1); releases.push(r); });
    const w2 = acquireLoopSlot().then((r) => { order.push(2); releases.push(r); });
    const w3 = acquireLoopSlot().then((r) => { order.push(3); releases.push(r); });
    await tick();
    expect(loopSlotStats().queued).toBe(3);

    held1();        // → waiter 1
    await w1;
    held2();        // → waiter 2
    await w2;
    releases[0]();  // waiter 1's slot → waiter 3
    await w3;

    expect(order).toEqual([1, 2, 3]);
    releases[1]();
    releases[2]();
    expect(loopSlotStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('release is idempotent', async () => {
    const r = await acquireLoopSlot();
    expect(loopSlotStats().running).toBe(1);
    r();
    r();
    r();
    expect(loopSlotStats().running).toBe(0);
  });

  it('frees the slot regardless of how the loop ended (success or error)', async () => {
    // Simulate a loop that throws: the caller releases in finally.
    const release = await acquireLoopSlot();
    try {
      throw new Error('loop blew up');
    } catch {
      // ignored
    } finally {
      release();
    }
    expect(loopSlotStats().running).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('already gone'));
    await expect(acquireLoopSlot(ac.signal)).rejects.toThrow('already gone');
    expect(loopSlotStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('removes a queued waiter when its signal aborts, without touching running', async () => {
    const held1 = await acquireLoopSlot();
    const held2 = await acquireLoopSlot();

    const ac = new AbortController();
    const queued = acquireLoopSlot(ac.signal);
    await tick();
    expect(loopSlotStats()).toMatchObject({ running: 2, queued: 1 });

    ac.abort(new Error('cancelled while queued'));
    await expect(queued).rejects.toThrow('cancelled while queued');
    // The abort removed the waiter; running is unchanged and the queue is empty.
    expect(loopSlotStats()).toMatchObject({ running: 2, queued: 0 });

    // The freed-up producers can still hand their slots to a later waiter.
    let granted = false;
    const next = acquireLoopSlot().then((r) => { granted = true; r(); });
    await tick();
    expect(granted).toBe(false);
    held1();
    await next;
    expect(granted).toBe(true);
    held2();
    expect(loopSlotStats()).toMatchObject({ running: 0, queued: 0 });
  });
});
