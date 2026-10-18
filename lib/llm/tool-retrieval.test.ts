import { describe, expect, it, vi } from 'vitest';

// No embedding provider in tests: shortlistTools falls back to lexical ranking
// over this catalog.
vi.mock('./embeddings', () => ({
  embedTexts: async () => {
    throw new Error('no embedding provider');
  },
  cosineSimilarity: () => 0,
}));
vi.mock('./tool-catalog', () => ({
  getMcpToolCatalog: async () => [
    { name: 'cja_list_segments', description: 'list segments segment audiences', inputSchema: {} },
    { name: 'adobe_list_segments', description: 'list segments segment audiences', inputSchema: {} },
    { name: 'reactor_list_rules', description: 'list rules on a tag property', inputSchema: {} },
  ],
}));

const { shortlistTools } = await import('./tool-retrieval');

describe('shortlistTools include filter', () => {
  it('ranks only tools the filter accepts, so filtered-out tools take no slots', async () => {
    const all = await shortlistTools('list segments', { k: 2 });
    expect(all).toEqual(['cja_list_segments', 'adobe_list_segments']);

    const onlyAep = await shortlistTools('list segments', { k: 2, include: (n) => !n.startsWith('cja_') });
    expect(onlyAep).toEqual(['adobe_list_segments', 'reactor_list_rules']);
  });
});
