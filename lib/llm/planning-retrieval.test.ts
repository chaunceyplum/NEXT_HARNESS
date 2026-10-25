import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let respond: () => unknown = () => ({ results: [] });

vi.mock('@/lib/mcp-client', () => ({
  callMcpTool: async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return respond();
  },
  listMcpTools: async () => ({ tools: [] }),
}));

let sampled = false;
vi.mock('./rag-judge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rag-judge')>()),
  shouldJudgeLiveResult: () => sampled,
  judgeRagResult: async () => ({ verdict: 'good' }),
}));

const { retrieveForPlanning } = await import('./planning-retrieval');

const available = new Set(['search_adobe_knowledge', 'adobe_list_segments']);
const good = { results: [{ title: 'Merge policies', text: 'Edge segmentation requires an edge merge policy.' }] };

beforeEach(() => {
  calls.length = 0;
  sampled = false;
  respond = () => good;
});

describe('retrieveForPlanning', () => {
  it('makes one lookup and returns the excerpts as planning context', async () => {
    const out = await retrieveForPlanning('Which merge policy does edge segmentation need?', { available });
    expect(calls).toEqual([{ tool: 'search_adobe_knowledge', args: { query: 'Which merge policy does edge segmentation need?' } }]);
    expect(out?.context).toContain('Knowledge-base excerpts');
    expect(out?.context).toContain('Edge segmentation requires an edge merge policy.');
  });

  it('caps a long request before using it as the query', async () => {
    await retrieveForPlanning(`merge policy ${'x'.repeat(5_000)}`, { available });
    expect((calls[0].args.query as string).length).toBe(1_000);
  });

  it('does nothing when the knowledge tool is not in the catalog', async () => {
    expect(await retrieveForPlanning('merge policy', { available: new Set(['adobe_list_segments']) })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('drops an empty or off-topic result instead of showing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond = () => ({ results: [] });
    expect(await retrieveForPlanning('edge merge policy', { available })).toBeUndefined();
    respond = () => ({ results: [{ title: 'Launch rules', text: 'Rule conditions fire on page load.' }] });
    expect(await retrieveForPlanning('edge segmentation merge policy', { available })).toBeUndefined();
    warn.mockRestore();
  });

  it('runs without excerpts when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond = () => {
      throw new Error('503: unavailable');
    };
    expect(await retrieveForPlanning('merge policy', { available })).toBeUndefined();
    warn.mockRestore();
  });

  it('hands a sampled lookup to the RAG judge sink', async () => {
    sampled = true;
    const tracked: Array<Promise<unknown>> = [];
    await retrieveForPlanning('edge segmentation merge policy', { available, sink: { track: (p) => tracked.push(p), drain: async () => [] } });
    expect(tracked).toHaveLength(1);
    await expect(tracked[0]).resolves.toMatchObject({ toolName: 'search_adobe_knowledge', judgment: { verdict: 'good' } });
  });
});
