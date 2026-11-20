import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool, jsonSchema } from 'ai';
import { knowledgeSearchesPerRun, knowledgeSearchTool } from './knowledge-search';

const exec = (t: unknown, input: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 'c', messages: [] });

function source() {
  const calls: string[] = [];
  const t = tool({
    description: 'kb',
    inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } } }),
    execute: async ({ query }) => {
      calls.push(query);
      return { results: [{ title: `Doc for ${query}` }] };
    },
  });
  return { t, calls };
}

describe('knowledgeSearchesPerRun', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 4, allows 0 to turn the tool off, and caps at 20', () => {
    expect(knowledgeSearchesPerRun()).toBe(4);
    vi.stubEnv('KNOWLEDGE_SEARCHES_PER_RUN', '0');
    expect(knowledgeSearchesPerRun()).toBe(0);
    vi.stubEnv('KNOWLEDGE_SEARCHES_PER_RUN', '99');
    expect(knowledgeSearchesPerRun()).toBe(20);
    vi.stubEnv('KNOWLEDGE_SEARCHES_PER_RUN', 'lots');
    expect(knowledgeSearchesPerRun()).toBe(4);
  });
});

describe('search_knowledge', () => {
  it('searches through the source tool and numbers each search', async () => {
    const { t, calls } = source();
    const search = knowledgeSearchTool(t, 2);
    expect(await exec(search, { query: 'XDM identity map' })).toEqual({ search: '1 of 2', result: { results: [{ title: 'Doc for XDM identity map' }] } });
    expect(calls).toEqual(['XDM identity map']);
  });

  it('stops searching at the limit, without calling the source', async () => {
    const { t, calls } = source();
    const search = knowledgeSearchTool(t, 2);
    await exec(search, { query: 'a' });
    await exec(search, { query: 'b' });
    const third = (await exec(search, { query: 'c' })) as { limitReached: boolean; message: string };
    expect(third.limitReached).toBe(true);
    expect(third.message).toMatch(/2 knowledge searches are used up/);
    expect(calls).toEqual(['a', 'b']);
  });

  it('returns a repeated query\'s stored result without using a search', async () => {
    const { t, calls } = source();
    const search = knowledgeSearchTool(t, 2);
    await exec(search, { query: 'Merge Policies' });
    const again = (await exec(search, { query: '  merge   policies ' })) as { repeated: boolean; result: unknown };
    expect(again.repeated).toBe(true);
    expect(again.result).toEqual({ results: [{ title: 'Doc for Merge Policies' }] });
    expect(calls).toHaveLength(1);
    expect(await exec(search, { query: 'other' })).toMatchObject({ search: '2 of 2' });
  });

  it('keeps per-run state per instance', async () => {
    const { t } = source();
    await exec(knowledgeSearchTool(t, 1), { query: 'a' });
    expect(await exec(knowledgeSearchTool(t, 1), { query: 'b' })).toMatchObject({ search: '1 of 1' });
  });
});
