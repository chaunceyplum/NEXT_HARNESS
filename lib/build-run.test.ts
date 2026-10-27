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

  // Requirement 12.4: an orchestrated run resumes from its DONE steps — the
  // context keeps the done steps and their WorkerResults (summary + ids) and
  // lists the steps that still have to run.
  it('resumes an orchestrated run from its done steps and their worker results', () => {
    const orchestratedRecord: ExecutionRecord = {
      id: 'run-2',
      createdAt: '2026-09-29T00:00:00Z',
      description: 'build two data elements and a rule',
      model: 'm',
      allowFullBuild: false,
      status: 'interrupted',
      durationMs: 1,
      request: { description: 'build two data elements and a rule' },
      result: {
        runId: 'run-2',
        finalText: '',
        steps: [],
        toolsConsidered: [],
        finishReason: 'running',
        usage: {},
        orchestrated: true,
        replans: 0,
        plan: {
          goal: 'build two data elements and a rule',
          version: 1,
          steps: [
            { id: 1, description: 'read property', tool: 'reactor_get_property', expectedOutput: 'property', dependsOn: [], status: 'done' },
            { id: 2, description: 'create data element A', tool: 'reactor_create_data_element', expectedOutput: 'DE', dependsOn: [1], status: 'done' },
            { id: 3, description: 'create rule', tool: 'reactor_create_rule', expectedOutput: 'rule', dependsOn: [2], status: 'pending' },
          ],
        },
        workers: [
          {
            workerId: 'run-2:w1:1', stepId: 1, attempt: 1, modelKey: 'm', status: 'done',
            steps: [], startedAt: '2026-09-29T00:00:00Z',
            budgetUsage: { tokens: 10, durationMs: 1 },
            result: { stepId: 1, status: 'done', summary: 'read property PR1', ids: { propertyId: 'PR1' } },
          },
          {
            workerId: 'run-2:w2:1', stepId: 2, attempt: 1, modelKey: 'm', status: 'done',
            steps: [], startedAt: '2026-09-29T00:00:00Z',
            budgetUsage: { tokens: 20, durationMs: 1 },
            result: { stepId: 2, status: 'done', summary: 'created data element', ids: { dataElementId: 'DE9' } },
          },
        ],
      },
    };

    const text = resumeContextFrom(orchestratedRecord);
    expect(text).toContain('orchestrated run');
    expect(text).toContain('2 step(s) done');
    // Done steps and their ids are carried so the resumed run reuses them.
    expect(text).toContain('Step 1 (read property): read property PR1 ids={"propertyId":"PR1"}');
    expect(text).toContain('Step 2 (create data element A): created data element ids={"dataElementId":"DE9"}');
    // The not-done step is listed as still to do.
    expect(text).toMatch(/Steps still to do:[\s\S]*Step 3 \(create rule\)/);
    expect(text).toMatch(/do not redo these/);
  });
});
