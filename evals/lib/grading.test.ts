import { describe, expect, it } from 'vitest';
import { gradeRagJudgment, gradeShortlist, gradeTrajectory, type RecordedCall } from './grading';
import { buildScriptedTools } from './scripted-tools';

const call = (toolName: string, input: unknown = {}): RecordedCall => ({ toolName, input });

describe('gradeTrajectory', () => {
  it('passes a trajectory that meets every expectation', () => {
    const calls = [call('github_read_file', { path: 'src/config.json' }), call('msb_github_commit_code', { files: '{}' })];
    expect(
      gradeTrajectory(calls, 'stop', {
        mustCall: ['github_read_file', 'msb_github_commit_code'],
        mustNotCall: ['execute_sql'],
        callOrder: [['github_read_file', 'msb_github_commit_code']],
        maxToolCalls: 4,
        argsContain: [{ tool: 'github_read_file', contains: 'CONFIG.json' }],
        finishReasons: ['stop'],
      })
    ).toEqual([]);
  });

  it('reports missing, forbidden, and over-budget calls', () => {
    const calls = [call('execute_sql'), call('adobe_update_segment'), call('adobe_update_segment'), call('adobe_update_segment')];
    const failures = gradeTrajectory(calls, 'tool-calls', {
      mustCall: ['adobe_get_segment'],
      mustNotCall: ['execute_sql'],
      maxToolCalls: 3,
      maxCallsPerTool: { adobe_update_segment: 2 },
      finishReasons: ['stop'],
    });
    expect(failures).toHaveLength(5);
    expect(failures.join('\n')).toMatch(/never called adobe_get_segment/);
    expect(failures.join('\n')).toMatch(/forbidden tool execute_sql/);
    expect(failures.join('\n')).toMatch(/adobe_update_segment ×3, expected ≤ 2/);
  });

  it('flags a commit made before reading, and an order it cannot verify', () => {
    const calls = [call('msb_github_commit_code'), call('github_read_file')];
    expect(gradeTrajectory(calls, 'stop', { callOrder: [['github_read_file', 'msb_github_commit_code']] })).toEqual([
      'called msb_github_commit_code before github_read_file',
    ]);
    expect(gradeTrajectory([], 'stop', { callOrder: [['a', 'b']] })[0]).toMatch(/unverifiable/);
  });
});

describe('gradeShortlist', () => {
  it('computes recall and 1-based ranks', () => {
    expect(gradeShortlist(['x', 'flow_disable', 'y'], ['flow_disable', 'flow_enable'])).toEqual({
      recall: 0.5,
      missing: ['flow_enable'],
      ranks: { flow_disable: 2 },
    });
  });
});

describe('gradeRagJudgment', () => {
  const judgment = { relevance: 1, sufficient: false, verdict: 'poor' as const, rationale: '', judgeModel: 'm' };

  it('passes a judgment inside the expected band', () => {
    expect(gradeRagJudgment(judgment, { verdictOneOf: ['poor'], sufficient: false, relevanceMax: 1 })).toEqual([]);
  });

  it('reports every out-of-band field', () => {
    expect(gradeRagJudgment(judgment, { verdictOneOf: ['good'], sufficient: true, relevanceMin: 4 })).toHaveLength(3);
  });
});

describe('buildScriptedTools', () => {
  it('records calls and replays responses in order, repeating the last', async () => {
    const { tools, calls } = buildScriptedTools([
      { name: 't', description: 'd', responses: [{ result: 1 }, { error: 'boom' }] },
    ]);
    const exec = (input: unknown) =>
      (tools.t.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'x', messages: [] });
    await expect(exec({ a: 1 })).resolves.toBe(1);
    await expect(exec({})).rejects.toThrow('boom');
    await expect(exec({})).rejects.toThrow('boom');
    expect(calls.map((c) => c.input)).toEqual([{ a: 1 }, {}, {}]);
  });
});
