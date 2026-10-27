import { describe, expect, it } from 'vitest';
import { normaliseResult } from './execution-store';
import type { ExecutionRecord } from './types';

type Result = NonNullable<ExecutionRecord['result']>;

const base: Result = { runId: 'r', finalText: '', steps: [], toolsConsidered: [], finishReason: 'stop', usage: {} };
const orchestration = { orchestrated: true, replans: 1, workers: [] } satisfies Partial<Result>;

describe('normaliseResult (Requirement 12.3)', () => {
  it('keeps orchestration fields on a completed record, which has no checkpoint', () => {
    expect(normaliseResult({ ...base, ...orchestration })).toMatchObject(orchestration);
  });

  it('keeps them on a v2 checkpoint', () => {
    const checkpoint = { schemaVersion: 2, step: 0, savedAt: '2026-10-01T00:00:00Z' };
    expect(normaliseResult({ ...base, ...orchestration, checkpoint })).toMatchObject(orchestration);
  });

  it('reads a v1 checkpoint as single-agent', () => {
    const checkpoint = { schemaVersion: 1, step: 0, savedAt: '2026-10-01T00:00:00Z' };
    const out = normaliseResult({ ...base, ...orchestration, checkpoint });
    expect(out).not.toHaveProperty('orchestrated');
    expect(out).not.toHaveProperty('workers');
    expect(out).not.toHaveProperty('replans');
  });
});
