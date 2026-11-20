import { describe, expect, it } from 'vitest';
import { canTransition, endStatusOnError, isActive, isResumable, isRunStatus, isTerminal, RUN_STATUSES, transition } from './run-lifecycle';

describe('run lifecycle', () => {
  it('moves between running and awaiting_approval', () => {
    expect(transition('running', 'awaiting_approval')).toBe('awaiting_approval');
    expect(transition('awaiting_approval', 'running')).toBe('running');
  });

  it('ends from running in any end state, and from awaiting_approval in all but completed', () => {
    for (const end of ['completed', 'failed', 'cancelled', 'interrupted'] as const) expect(canTransition('running', end)).toBe(true);
    for (const end of ['failed', 'cancelled', 'interrupted'] as const) expect(canTransition('awaiting_approval', end)).toBe(true);
    expect(canTransition('awaiting_approval', 'completed')).toBe(false);
  });

  it('never leaves an end state', () => {
    for (const end of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(isTerminal(end)).toBe(true);
      for (const to of RUN_STATUSES) expect(canTransition(end, to)).toBe(false);
    }
    expect(() => transition('completed', 'running')).toThrow(/Illegal run status change: completed -> running/);
  });

  it('classifies active and resumable statuses', () => {
    expect(RUN_STATUSES.filter(isActive)).toEqual(['running', 'awaiting_approval']);
    expect(RUN_STATUSES.filter(isResumable)).toEqual(['failed', 'cancelled', 'interrupted']);
  });

  it('ends a thrown run as cancelled only when its abort signal fired', () => {
    expect(endStatusOnError(true)).toBe('cancelled');
    expect(endStatusOnError(false)).toBe('failed');
  });

  it('recognises stored status strings', () => {
    expect(isRunStatus('awaiting_approval')).toBe(true);
    expect(isRunStatus('done')).toBe(false);
  });
});
