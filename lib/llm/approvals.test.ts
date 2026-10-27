import { afterEach, describe, expect, it } from 'vitest';
import { resolveApproval, waitForApproval } from './approvals';

afterEach(() => {
  delete process.env.APPROVAL_TIMEOUT_MS;
});

describe('approvals', () => {
  it('resolves a pending call with the decision, once', async () => {
    const pending = waitForApproval('run1', 'c1');
    expect(resolveApproval('run1', 'c1', true)).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: true });
    expect(resolveApproval('run1', 'c1', false)).toBe(false);
  });

  it('records who decided', async () => {
    const pending = waitForApproval('run-who', 'c1');
    resolveApproval('run-who', 'c1', false, 'bob');
    await expect(pending).resolves.toEqual({ approved: false, reason: 'Denied by "bob".', decidedBy: 'bob' });
  });

  it('returns false for a call nothing is waiting on', () => {
    expect(resolveApproval('nope', 'nope', true)).toBe(false);
  });

  it('denies on timeout', async () => {
    process.env.APPROVAL_TIMEOUT_MS = '20';
    await expect(waitForApproval('run2', 'c1')).resolves.toMatchObject({ approved: false, reason: expect.stringMatching(/No approval decision/) });
  });

  it('denies when the run is aborted', async () => {
    const ctrl = new AbortController();
    const pending = waitForApproval('run3', 'c1', ctrl.signal);
    ctrl.abort();
    await expect(pending).resolves.toMatchObject({ approved: false, reason: expect.stringMatching(/cancelled/) });
    expect(resolveApproval('run3', 'c1', true)).toBe(false);
  });

  // Task 7.2 (Req 9.5): worker tool calls route through this same registry, so
  // several approvals can be pending at once for one run (one per concurrent
  // worker's tool call, keyed by run id + tool-call id) and resolve
  // independently without affecting the others.
  it('holds several pending approvals for one run at once and resolves them independently', async () => {
    const a = waitForApproval('run-multi', 'w1:c1');
    const b = waitForApproval('run-multi', 'w2:c1');
    const c = waitForApproval('run-multi', 'w3:c1');

    // Approving one worker's call leaves the others pending.
    expect(resolveApproval('run-multi', 'w2:c1', true, 'alice')).toBe(true);
    await expect(b).resolves.toMatchObject({ approved: true, decidedBy: 'alice' });

    // The other two are still waiting and decide independently.
    expect(resolveApproval('run-multi', 'w1:c1', false, 'bob')).toBe(true);
    expect(resolveApproval('run-multi', 'w3:c1', true, 'carol')).toBe(true);
    await expect(a).resolves.toMatchObject({ approved: false, decidedBy: 'bob' });
    await expect(c).resolves.toMatchObject({ approved: true, decidedBy: 'carol' });
  });
});
