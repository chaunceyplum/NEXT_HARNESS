import { describe, expect, it } from 'vitest';
import { describeTool, describeTools } from './tool-registry';
import { CREDENTIAL_TOOLS, OUTBOUND_TOOLS, SQL_TOOLS } from './tool-taxonomy';

describe('describeTool', () => {
  it('profiles a destructive AEP segment tool', () => {
    expect(describeTool('adobe_delete_segment')).toEqual({
      name: 'adobe_delete_segment',
      access: 'destructive',
      platforms: ['AEP Core'],
      domain: 'segments',
      outbound: false,
      credentials: false,
      runsSql: false,
      knowledge: false,
      local: false,
      adobeScoped: true,
      approval: 'destructive',
    });
  });

  it('profiles a Launch publish transition as outbound and Launch-owned', () => {
    expect(describeTool('reactor_transition_library')).toMatchObject({
      access: 'write',
      platforms: ['Tags (Reactor)'],
      domain: 'launch',
      outbound: true,
      approval: 'outbound',
    });
  });

  it('marks the local profile-field lookup as a local, segment-owned read', () => {
    expect(describeTool('aep_find_profile_fields')).toMatchObject({ access: 'read', local: true, domain: 'segments', approval: 'never' });
  });

  it('reports SQL tools as approval-dependent on the statement', () => {
    expect(describeTool('execute_sql')).toMatchObject({ runsSql: true, approval: 'when-sql-writes' });
  });

  it('reports every platform group a tool matches', () => {
    // query_rag_db is both a Query Service prefix match and a Knowledge tool.
    expect(describeTool('query_rag_db')).toMatchObject({ platforms: ['Query Service', 'Knowledge'], knowledge: true, access: 'read' });
  });

  it('leaves CJA segments out of the AEP segments domain', () => {
    expect(describeTool('cja_list_segments').domain).toBeUndefined();
  });

  it('sorts and de-duplicates a list', () => {
    expect(describeTools(['b_get', 'a_get', 'b_get']).map((t) => t.name)).toEqual(['a_get', 'b_get']);
  });
});

describe('tool taxonomy invariants', () => {
  it('no outbound tool is classified as a read (read-only runs must drop them)', () => {
    for (const name of OUTBOUND_TOOLS) expect(describeTool(name).access, name).not.toBe('read');
  });

  it('every outbound tool waits for approval in autonomous mode', () => {
    for (const name of OUTBOUND_TOOLS) expect(['outbound', 'destructive'], name).toContain(describeTool(name).approval);
  });

  it('every credential tool waits for approval', () => {
    for (const name of CREDENTIAL_TOOLS) expect(describeTool(name).approval, name).toBe('credentials');
  });

  it('SQL tools are never treated as plain reads by the approval gate', () => {
    for (const name of SQL_TOOLS) expect(describeTool(name).approval, name).toBe('when-sql-writes');
  });
});
