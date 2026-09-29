import { afterEach, describe, expect, it } from 'vitest';
import { approvalReason, isReadOnlySql, resolveRolloutMode } from './approval-policy';

describe('isReadOnlySql', () => {
  it('accepts a single plain read', () => {
    for (const sql of [
      'SELECT * FROM harness_agent_runs ORDER BY created_at DESC LIMIT 5',
      'select count(*) from t where note = \'drop table x\'',
      'WITH recent AS (SELECT id FROM t) SELECT * FROM recent',
      'EXPLAIN SELECT 1',
      '  -- a comment with delete in it\nSELECT 1;',
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it('rejects anything that could change state, and anything unparseable', () => {
    for (const sql of [
      'DROP TABLE harness_agent_runs',
      'DELETE FROM t',
      'SELECT 1; DELETE FROM t',
      'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
      'SELECT * INTO backup FROM t',
      'SELECT pg_terminate_backend(123)',
      'SELECT set_config(\'role\', \'admin\', false)',
      'UPDATE t SET a = 1',
      'CREATE TABLE x (id int)',
      '',
      undefined,
      42,
    ]) {
      expect(isReadOnlySql(sql), String(sql)).toBe(false);
    }
  });
});

describe('approvalReason', () => {
  it('flags destructive, SQL writes, outbound, and credential calls', () => {
    expect(approvalReason('adobe_delete_segment', {})).toBe('destructive');
    expect(approvalReason('execute_sql', { sql: 'DROP TABLE t' })).toBe('sql-write');
    expect(approvalReason('execute_sql', { sql: 'SELECT 1' })).toBeUndefined();
    expect(approvalReason('msb_github_commit_code', {})).toBe('outbound');
    expect(approvalReason('destination_create_dataflow', {})).toBe('outbound');
    expect(approvalReason('reactor_transition_library', {})).toBe('outbound');
    expect(approvalReason('flow_get_landing_zone_credentials', {})).toBe('credentials');
    expect(approvalReason('adobe_create_segment', {})).toBeUndefined();
    expect(approvalReason('adobe_list_segments', {})).toBeUndefined();
  });

  it('asks before every write in assisted mode, never before a read', () => {
    expect(approvalReason('adobe_create_segment', {}, { mode: 'assisted' })).toBe('assisted-mode');
    expect(approvalReason('adobe_list_segments', {}, { mode: 'assisted' })).toBeUndefined();
  });

  it('does not ask for calls that will not execute (dry-run / shadow), except credential reads', () => {
    expect(approvalReason('adobe_delete_segment', {}, { dryRun: true })).toBeUndefined();
    expect(approvalReason('execute_sql', { sql: 'DROP TABLE t' }, { mode: 'shadow' })).toBeUndefined();
    expect(approvalReason('msb_github_commit_code', {}, { mode: 'shadow' })).toBeUndefined();
    expect(approvalReason('flow_get_landing_zone_credentials', {}, { mode: 'shadow' })).toBe('credentials');
    // dry-run only neutralises destructive tools; outbound writes still execute.
    expect(approvalReason('msb_github_commit_code', {}, { dryRun: true })).toBe('outbound');
  });
});

describe('resolveRolloutMode', () => {
  afterEach(() => {
    delete process.env.ROLLOUT_MODE;
  });

  it('defaults to autonomous and lets a request tighten it', () => {
    expect(resolveRolloutMode()).toBe('autonomous');
    expect(resolveRolloutMode('assisted')).toBe('assisted');
  });

  it('never lets a request loosen ROLLOUT_MODE', () => {
    process.env.ROLLOUT_MODE = 'assisted';
    expect(resolveRolloutMode('autonomous')).toBe('assisted');
    expect(resolveRolloutMode('shadow')).toBe('shadow');
  });
});
