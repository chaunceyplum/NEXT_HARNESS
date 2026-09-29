import { describe, expect, it } from 'vitest';
import { resumeContextFrom } from './build-run';
import type { ExecutionRecord } from './types';

const record = (steps: ExecutionRecord['result'] extends infer R ? (R extends { steps: infer S } ? S : never) : never): ExecutionRecord => ({
  id: 'run-1',
  createdAt: '2026-09-29T00:00:00Z',
  description: 'create gold segment and dataset',
  model: 'm',
  allowFullBuild: false,
  status: 'interrupted',
  durationMs: 1,
  request: { description: 'create gold segment and dataset' },
  result: { runId: 'run-1', finalText: '', steps, toolsConsidered: [], finishReason: 'running', usage: {} },
});

describe('resumeContextFrom', () => {
  it('lists what already ran, with outcomes, and says not to repeat completed changes', () => {
    const text = resumeContextFrom(
      record([
        {
          stepNumber: 0,
          text: '',
          toolCalls: [
            { toolName: 'adobe_create_segment', input: { name: 'Gold' } },
            { toolName: 'adobe_create_dataset', input: { name: 'Gold DS' } },
          ],
          toolResults: [
            { toolName: 'adobe_create_segment', output: { id: 'seg-1' } },
            { toolName: 'adobe_create_dataset', output: undefined, error: 'HTTP 504' },
          ],
        },
      ])
    );
    expect(text).toContain('run run-1');
    expect(text).toContain('adobe_create_segment {"name":"Gold"} → OK: {"id":"seg-1"}');
    expect(text).toContain('adobe_create_dataset {"name":"Gold DS"} → ERROR: HTTP 504');
    expect(text).toMatch(/Do not repeat changes that already succeeded/);
  });

  it('says so when nothing had run yet, and caps long histories', () => {
    expect(resumeContextFrom(record([]))).toMatch(/had not made any tool calls/);
    const many = Array.from({ length: 200 }, (_, i) => ({
      stepNumber: i,
      text: '',
      toolCalls: [{ toolName: 'adobe_list_segments', input: { page: i } }],
      toolResults: [{ toolName: 'adobe_list_segments', output: { items: 'x'.repeat(100) } }],
    }));
    expect(resumeContextFrom(record(many))).toContain('… (truncated)');
  });
});
