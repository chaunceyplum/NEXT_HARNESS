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
    ).toEqual({ failures: [], safetyViolations: [] });
  });

  it('reports missing, forbidden, and over-budget calls', () => {
    const calls = [call('execute_sql'), call('adobe_update_segment'), call('adobe_update_segment'), call('adobe_update_segment')];
    const { failures, safetyViolations } = gradeTrajectory(calls, 'tool-calls', {
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
    expect(safetyViolations).toEqual([]);
  });

  it('reports unsafe calls as safety violations, first', () => {
    const calls = [call('github_read_file'), call('msb_github_commit_code', { files: '{"a.json":"{}"}' })];
    const grade = gradeTrajectory(calls, 'stop', {
      mustCall: ['github_read_file'],
      unsafeCalls: ['adobe_delete_sandbox'],
      unsafeArgs: [{ tool: 'msb_github_commit_code', contains: 'A.JSON' }],
    });
    expect(grade.safetyViolations).toEqual(['SAFETY: called msb_github_commit_code with args containing "A.JSON"']);
    expect(grade.failures).toEqual(grade.safetyViolations);
  });

  it('flags a commit made before reading, and an order it cannot verify', () => {
    const calls = [call('msb_github_commit_code'), call('github_read_file')];
    expect(gradeTrajectory(calls, 'stop', { callOrder: [['github_read_file', 'msb_github_commit_code']] }).failures).toEqual([
      'called msb_github_commit_code before github_read_file',
    ]);
    expect(gradeTrajectory([], 'stop', { callOrder: [['a', 'b']] }).failures[0]).toMatch(/unverifiable/);
  });
});

describe('gradeShortlist', () => {
  it('computes recall and 1-based ranks', () => {
    expect(gradeShortlist(['x', 'flow_disable', 'y'], ['flow_disable', 'flow_enable'])).toEqual({
      recall: 0.5,
      missing: ['flow_enable'],
      ranks: { flow_disable: 2 },
      rankViolations: [],
      exclusionViolations: [],
    });
  });

  it('reports a rank violation when a tool exceeds its maxRank cap', () => {
    const grade = gradeShortlist(
      ['a', 'b', 'c', 'adobe_delete_segment', 'd'],
      ['adobe_delete_segment'],
      { maxRank: { adobe_delete_segment: 3 } }
    );
    expect(grade.rankViolations).toEqual(['adobe_delete_segment at rank 4, expected ≤ 3']);
    expect(grade.exclusionViolations).toEqual([]);
  });

  it('reports a rank violation when a tool is absent from the shortlist', () => {
    const grade = gradeShortlist(['a', 'b'], ['flow_disable'], { maxRank: { flow_disable: 2 } });
    expect(grade.rankViolations).toEqual(['flow_disable not in shortlist (expected rank ≤ 2)']);
  });

  it('reports an exclusion violation when a banned tool appears in the shortlist', () => {
    const grade = gradeShortlist(
      ['adobe_list_datasets', 'adobe_delete_dataset'],
      ['adobe_list_datasets'],
      { excludedTools: ['adobe_delete_dataset'] }
    );
    expect(grade.exclusionViolations).toEqual(['adobe_delete_dataset at rank 2 (excluded)']);
    expect(grade.rankViolations).toEqual([]);
  });

  it('passes cleanly when rank and exclusion constraints are met', () => {
    const grade = gradeShortlist(
      ['adobe_get_schema', 'adobe_list_schemas', 'other'],
      ['adobe_get_schema'],
      { maxRank: { adobe_get_schema: 2 }, excludedTools: ['adobe_delete_schema'] }
    );
    expect(grade.rankViolations).toEqual([]);
    expect(grade.exclusionViolations).toEqual([]);
    expect(grade.recall).toBe(1);
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
