import { describe, expect, it } from 'vitest';
import { tool, jsonSchema, type ToolSet } from 'ai';
import { buildDiscoveryTools, effectiveToolCall, keywordScore } from './tool-discovery';
import type { McpToolDefinition } from './tool-catalog';

const CATALOG: McpToolDefinition[] = [
  { name: 'adobe_delete_segment', description: 'Delete a segment definition by id.', inputSchema: { type: 'object', properties: { segment_id: { type: 'string' } } } },
  { name: 'adobe_list_segments', description: 'List segment definitions in the sandbox.', inputSchema: { type: 'object' } },
  { name: 'adobe_create_segment_job', description: 'Evaluate segments into a segment job.', inputSchema: { type: 'object' } },
  { name: 'adobe_list_datasets', description: 'List datasets; each can feed segments and profiles.', inputSchema: { type: 'object' } },
  { name: 'adobe_get_merge_policy', description: 'Get one merge policy.', inputSchema: { type: 'object' } },
  { name: 'adobe_list_merge_policies', description: 'List merge policies.', inputSchema: { type: 'object' } },
  ...Array.from({ length: 8 }, (_, i) => ({ name: `reactor_tool_${i}`, description: 'Launch segment helper.', inputSchema: { type: 'object' } })),
];

const callable: ToolSet = Object.fromEntries(
  CATALOG.map((d) => [d.name, tool({ description: d.description!, inputSchema: jsonSchema({ type: 'object' }), execute: async () => ({ ran: d.name }) })])
);

const exec = (t: unknown, input: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 'c', messages: [] });

type Found = { tools: Array<{ name: string; inputSchema?: unknown }>; message: string };

describe('keywordScore', () => {
  it('weights the tool name over the description and folds plurals', () => {
    expect(keywordScore('delete segments', 'adobe_delete_segment', 'Delete a segment')).toBeGreaterThan(
      keywordScore('delete segments', 'adobe_list_segments', 'Delete-free listing of segments')
    );
    expect(keywordScore('merge policies', 'adobe_list_merge_policies', '')).toBe(3 + 3 + 2);
    expect(keywordScore('', 'x', 'y')).toBe(0);
  });
});

describe('find_tools', () => {
  it('ranks the tool whose name matches the request first', async () => {
    const { find_tools } = buildDiscoveryTools(CATALOG, callable, new Set());
    const out = (await exec(find_tools, { query: 'delete segment' })) as Found;
    expect(out.tools[0].name).toBe('adobe_delete_segment');
    expect(out.tools[0].inputSchema).toEqual(CATALOG[0].inputSchema);
  });

  it('returns up to 8 matches, only the best 4 with input schemas', async () => {
    const { find_tools } = buildDiscoveryTools(CATALOG, callable, new Set());
    const out = (await exec(find_tools, { query: 'segment' })) as Found;
    expect(out.tools).toHaveLength(8);
    expect(out.tools.filter((t) => t.inputSchema)).toHaveLength(4);
    expect(out.message).toMatch(/exact name to get it/);
  });

  it('uses the semantic ranker to find tools phrased differently from the query', async () => {
    // "audience" appears in no name or description; the ranker knows it means segments.
    const rank = async () => ['adobe_list_segments', 'adobe_create_segment_job'];
    const { find_tools } = buildDiscoveryTools(CATALOG, callable, new Set(), rank);
    const out = (await exec(find_tools, { query: 'list audiences' })) as Found;
    expect(out.tools[0].name).toBe('adobe_list_segments');
  });

  it('falls back to keywords when the ranker fails', async () => {
    const rank = async () => {
      throw new Error('embeddings down');
    };
    const { find_tools } = buildDiscoveryTools(CATALOG, callable, new Set(), rank);
    const out = (await exec(find_tools, { query: 'get merge policy' })) as Found;
    expect(out.tools[0].name).toBe('adobe_get_merge_policy');
  });

  it('only offers tools the policy left callable', async () => {
    const { adobe_delete_segment: _gone, ...rest } = callable;
    void _gone;
    const { find_tools } = buildDiscoveryTools(CATALOG, rest, new Set());
    const out = (await exec(find_tools, { query: 'delete segment' })) as Found;
    expect(out.tools.map((t) => t.name)).not.toContain('adobe_delete_segment');
  });
});

describe('call_tool', () => {
  it('runs a callable tool by name and refuses unknown ones', async () => {
    const { call_tool } = buildDiscoveryTools(CATALOG, callable, new Set());
    expect(await exec(call_tool, { tool_name: 'adobe_list_segments', arguments: {} })).toEqual({ ran: 'adobe_list_segments' });
    await expect(exec(call_tool, { tool_name: 'nope' })).rejects.toThrow(/not available on this run/);
    expect(effectiveToolCall('call_tool', { tool_name: 'x', arguments: { a: 1 } })).toEqual({ toolName: 'x', input: { a: 1 } });
  });
});
