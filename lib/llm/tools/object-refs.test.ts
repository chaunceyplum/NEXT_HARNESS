import { describe, expect, it } from 'vitest';
import { describeWrite, idFromResult, lineageFromSteps, objectsIn, refForCall } from './object-refs';
import type { StepRecord } from '../../types';

describe('describeWrite', () => {
  it('reads <platform>_<verb>_<object> tool names', () => {
    expect(describeWrite('adobe_create_segment')).toEqual({ platform: 'adobe', change: 'created', object: 'segment' });
    expect(describeWrite('reactor_update_data_element')).toEqual({ platform: 'reactor', change: 'updated', object: 'data_element' });
    expect(describeWrite('cja_delete_calculated_metric')).toEqual({ platform: 'cja', change: 'deleted', object: 'calculated_metric' });
    expect(describeWrite('cja_copy_project')).toEqual({ platform: 'cja', change: 'created', object: 'project' });
    expect(describeWrite('reactor_install_extension')).toEqual({ platform: 'reactor', change: 'created', object: 'extension' });
  });

  it('reads <platform>_<object>_<verb> and verb-only tool names', () => {
    expect(describeWrite('query_schedule_create')).toEqual({ platform: 'query', change: 'created', object: 'schedule' });
    expect(describeWrite('flow_enable')).toEqual({ platform: 'flow', change: 'updated', object: 'flow' });
  });

  it('treats ..._to_<object> / ..._from_<object> as an update of that object', () => {
    expect(describeWrite('reactor_add_resources_to_library')).toEqual({ platform: 'reactor', change: 'updated', object: 'library' });
    expect(describeWrite('reactor_remove_resources_from_library')).toEqual({ platform: 'reactor', change: 'updated', object: 'library' });
  });

  it('ignores reads and non-Adobe tools', () => {
    expect(describeWrite('adobe_list_segments')).toBeUndefined();
    expect(describeWrite('reactor_get_rule')).toBeUndefined();
    expect(describeWrite('msb_github_commit_code')).toBeUndefined();
    expect(describeWrite('execute_sql')).toBeUndefined();
  });
});

describe('idFromResult', () => {
  it('reads the common response shapes', () => {
    expect(idFromResult({ id: 'seg-1' })).toBe('seg-1');
    expect(idFromResult({ data: { id: 'RL123', attributes: {} } })).toBe('RL123');
    expect(idFromResult({ $id: 'https://ns.adobe.com/tenant/schemas/abc' })).toBe('https://ns.adobe.com/tenant/schemas/abc');
    expect(idFromResult(['@/dataSets/65abc'])).toBe('65abc');
    expect(idFromResult('{"id":"DE1","name":"x"}')).toBe('DE1');
  });

  it('reads an id out of a truncated result string', () => {
    expect(idFromResult('{"data":{"id":"LB77","attributes":{"name":"lib"… (truncated — 9000 chars total.')).toBe('LB77');
  });

  it('returns undefined when there is no id', () => {
    expect(idFromResult({ ok: true })).toBeUndefined();
    expect(idFromResult(undefined)).toBeUndefined();
  });
});

describe('refForCall', () => {
  it('takes a create id from the result, with name and sandbox from the arguments', () => {
    expect(refForCall('adobe_create_segment', { name: 'Gold members', sandbox: 'prod' }, { id: 'seg-9' })).toEqual({
      ref: { kind: 'adobe:segment', id: 'seg-9', name: 'Gold members', sandbox: 'prod' },
      change: 'created',
      tool: 'adobe_create_segment',
    });
  });

  it('takes an update or delete id from the arguments', () => {
    expect(refForCall('adobe_delete_segment', { segment_id: 'seg-2' }, { ok: true })?.ref.id).toBe('seg-2');
    expect(refForCall('reactor_build_library', { library_id: 'LB1' }, { data: { id: 'BL5' } })?.ref).toEqual({ kind: 'reactor:library', id: 'LB1' });
  });

  it('unwraps call_tool', () => {
    expect(refForCall('call_tool', { tool_name: 'adobe_create_dataset', arguments: { name: 'crm' } }, ['@/dataSets/ds1'])).toMatchObject({
      ref: { kind: 'adobe:dataset', id: 'ds1', name: 'crm' },
      tool: 'adobe_create_dataset',
    });
  });

  it('records nothing for a dry-run description or a write with no findable id', () => {
    expect(refForCall('adobe_delete_segment', { segment_id: 's' }, { _dryRun: true, tool: 'adobe_delete_segment' })).toBeUndefined();
    expect(refForCall('adobe_create_segment', { name: 'x' }, { ok: true })).toBeUndefined();
  });
});

const step = (n: number, calls: Array<[string, unknown]>, results: Array<[string, unknown, string?]>, workerId?: string): StepRecord => ({
  stepNumber: n,
  text: '',
  toolCalls: calls.map(([toolName, input]) => ({ toolName, input })),
  toolResults: results.map(([toolName, output, error]) => ({ toolName, output, ...(error ? { error } : {}) })),
  ...(workerId ? { workerId } : {}),
});

describe('lineageFromSteps', () => {
  it('pairs calls with results of the same tool, in order, and skips reads and errors', () => {
    const steps = [
      step(1, [['adobe_list_segments', {}], ['adobe_create_segment', { name: 'a' }], ['adobe_create_segment', { name: 'b' }]], [
        ['adobe_list_segments', { items: [] }],
        ['adobe_create_segment', { id: 'seg-a' }],
        ['adobe_create_segment', undefined, '400: invalid PQL'],
      ]),
      step(2, [['adobe_update_segment', { id: 'seg-a', name: 'a2' }]], [['adobe_update_segment', { ok: true }]], 'r:w2:1'),
    ];
    expect(lineageFromSteps(steps)).toEqual([
      { ref: { kind: 'adobe:segment', id: 'seg-a', name: 'a' }, change: 'created', tool: 'adobe_create_segment', step: 1 },
      { ref: { kind: 'adobe:segment', id: 'seg-a', name: 'a2' }, change: 'updated', tool: 'adobe_update_segment', step: 2, workerId: 'r:w2:1' },
    ]);
  });

  it('records nothing for a denied call (it has an error and no output)', () => {
    const steps = [step(1, [['adobe_delete_segment', { segment_id: 's' }]], [['adobe_delete_segment', undefined, 'Not executed: denied']])];
    expect(lineageFromSteps(steps)).toEqual([]);
  });
});

describe('objectsIn', () => {
  it('rolls a lineage up to one entry per object, keeping "created" through later updates', () => {
    const lineage = lineageFromSteps([
      step(1, [['adobe_create_segment', { name: 'a' }]], [['adobe_create_segment', { id: 'seg-a' }]]),
      step(2, [['adobe_update_segment', { id: 'seg-a', name: 'a2' }], ['adobe_delete_segment', { id: 'seg-old' }]], [
        ['adobe_update_segment', {}],
        ['adobe_delete_segment', {}],
      ]),
    ]);
    expect(objectsIn(lineage)).toEqual([
      { kind: 'adobe:segment', id: 'seg-a', name: 'a2', change: 'created' },
      { kind: 'adobe:segment', id: 'seg-old', change: 'deleted' },
    ]);
  });
});
