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
});
