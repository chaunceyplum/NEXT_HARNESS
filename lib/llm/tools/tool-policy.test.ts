import { afterEach, describe, expect, it } from 'vitest';
import { tool, jsonSchema, type ToolSet } from 'ai';
import { applyToolPolicy, classifyTool } from './tool-policy';

describe('classifyTool', () => {
  it('classifies server-prefixed MCP names by their verb', () => {
    const cases: Record<string, string> = {
      adobe_delete_segment: 'destructive',
      adobe_delete_profile_entity: 'destructive',
      adobe_abort_batch: 'destructive',
      query_schedule_delete: 'destructive',
      adobe_create_privacy_job: 'destructive',
      msb_github_merge_pr: 'destructive',
      adobe_create_segment: 'write',
      reactor_create_rule: 'write',
      flow_disable: 'write',
      execute_sql: 'write',
      query_run: 'write',
      msb_github_commit_code: 'write',
      adobe_list_segments: 'read',
      search_adobe_knowledge: 'read',
      github_read_file: 'read',
      query_rag_db: 'read',
      knowledge_base_health: 'read',
    };
    for (const [name, level] of Object.entries(cases)) {
      expect(classifyTool(name), name).toBe(level);
    }
  });

  it('lets the first verb win so nouns do not misclassify', () => {
    expect(classifyTool('adobe_list_merge_policies')).toBe('read');
    expect(classifyTool('adobe_list_privacy_jobs')).toBe('read');
    expect(classifyTool('flow_get_run')).toBe('read');
    expect(classifyTool('adobe_create_merge_policy')).toBe('write');
  });

  it('fails closed as write for names with no recognised verb', () => {
    expect(classifyTool('some_new_thing')).toBe('write');
  });
});

describe('applyToolPolicy', () => {
  const mk = (name: string) =>
    tool({ description: name, inputSchema: jsonSchema({ type: 'object' }), execute: async () => ({ ran: name }) });
  const tools = (): ToolSet =>
    Object.fromEntries(['adobe_list_segments', 'adobe_create_segment', 'adobe_delete_segment'].map((n) => [n, mk(n)]));

  afterEach(() => {
    delete process.env.BUILD_POLICY;
    delete process.env.TOOL_DRY_RUN;
  });

  it('read-only removes write and destructive tools', () => {
    expect(Object.keys(applyToolPolicy(tools(), { mode: 'read-only' }))).toEqual(['adobe_list_segments', 'policy_info']);
  });

  it('does not let a request loosen BUILD_POLICY=read-only', () => {
    process.env.BUILD_POLICY = 'read-only';
    expect(Object.keys(applyToolPolicy(tools(), { mode: 'full' }))).toEqual(['adobe_list_segments', 'policy_info']);
  });

  it('does not let a request loosen TOOL_DRY_RUN=true', async () => {
    process.env.TOOL_DRY_RUN = 'true';
    const out = applyToolPolicy(tools(), { dryRun: false });
    const result = await out.adobe_delete_segment.execute!({}, { toolCallId: 't', messages: [] } as never);
    expect(result).toMatchObject({ _dryRun: true });
  });
});
