import { describe, expect, it, vi } from 'vitest';

// No embedding provider in tests: shortlistTools falls back to lexical ranking
// over this catalog.
let embedCalls = 0;
vi.mock('./embeddings', () => ({
  embedTexts: async () => {
    embedCalls++;
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

describe('shortlistTools embedding cooldown', () => {
  it('stops calling a failed embedding provider for a while, and tries again after', async () => {
    // Start past any cooldown an earlier test left behind.
    const start = Date.now() + 10 * 60_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(start);
      await shortlistTools('list segments');
      const afterFailure = embedCalls;
      await shortlistTools('list rules');
      expect(embedCalls).toBe(afterFailure);

      vi.setSystemTime(start + 6 * 60_000);
      await shortlistTools('list rules');
      expect(embedCalls).toBeGreaterThan(afterFailure);
    } finally {
      vi.useRealTimers();
    }
  });
});
