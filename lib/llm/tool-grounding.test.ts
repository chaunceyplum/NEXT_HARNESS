import { beforeEach, describe, expect, it, vi } from 'vitest';

// executeMcpToolWithRetry against a scripted MCP client: counts how many
// knowledge-base lookups each failure pattern actually costs.

const behavior: Record<string, () => unknown> = {};
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

vi.mock('@/lib/mcp-client', () => ({
  callMcpTool: async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const fn = behavior[tool];
    if (!fn) throw new Error(`unscripted tool ${tool}`);
    return fn();
  },
  listMcpTools: async () => ({ tools: [] }),
}));

const judge = vi.fn(async () => undefined);
vi.mock('./rag-judge', async (orig) => ({
  ...(await orig<typeof import('./rag-judge')>()),
  judgeRagResult: judge,
}));

const { createGroundingState, executeMcpToolWithRetry } = await import('./tool-catalog');

const available = new Set(['search_adobe_knowledge', 'adobe_create_schema']);
const lookups = () => calls.filter((c) => c.tool === 'search_adobe_knowledge').length;
const run = (grounding = createGroundingState(), args: Record<string, unknown> = { title: 'x' }) =>
  executeMcpToolWithRetry('adobe_create_schema', args, { maxRetries: 2, availableNames: available, grounding });

beforeEach(() => {
  calls.length = 0;
  judge.mockClear();
  for (const k of Object.keys(behavior)) delete behavior[k];
  behavior.search_adobe_knowledge = () => ({ results: ['docs'] });
  delete process.env.RAG_JUDGE_SAMPLE_RATE;
});

describe('knowledge-base grounding on tool failure', () => {
  it('does not look anything up for a transient error — just retries', async () => {
    let n = 0;
    behavior.adobe_create_schema = () => {
      if (n++ < 1) throw new Error('503 Service Unavailable');
      return { ok: true };
    };
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(lookups()).toBe(0);
  });

  it('skips the lookup on a first, informative validation error', async () => {
    behavior.adobe_create_schema = () => {
      throw new Error('422: {"message":"field \\"meta:class\\" is required"}');
    };
    await expect(run()).rejects.toThrow(/validation error/);
    expect(lookups()).toBe(0);
  });

  it('looks up once the same tool fails validation again, and reuses that lookup', async () => {
    behavior.adobe_create_schema = () => {
      throw new Error('422: {"message":"field \\"meta:class\\" is required"}');
    };
    const grounding = createGroundingState();
    await expect(run(grounding)).rejects.toThrow();
    await expect(run(grounding, { title: 'y' })).rejects.toThrow(/"reason":"repeat-failure"/);
    await expect(run(grounding, { title: 'z' })).rejects.toThrow(/"findings"/);
    expect(lookups()).toBe(1);
  });

  it('looks up on the first failure when the error says nothing actionable', async () => {
    behavior.adobe_create_schema = () => {
      throw new Error('400: Bad Request');
    };
    await expect(run()).rejects.toThrow(/"reason":"uninformative-error"/);
    expect(lookups()).toBe(1);
  });

  it('never runs the judge on a grounding lookup', async () => {
    behavior.adobe_create_schema = () => {
      throw new Error('400: Bad Request');
    };
    await expect(run()).rejects.toThrow();
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('judging the agent’s own knowledge searches', () => {
  const search = () =>
    executeMcpToolWithRetry('search_adobe_knowledge', { query: 'merge policy' }, { maxRetries: 1, availableNames: available });

  it('judges every search at sample rate 1', async () => {
    process.env.RAG_JUDGE_SAMPLE_RATE = '1';
    await search();
    await search();
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('judges none at sample rate 0', async () => {
    process.env.RAG_JUDGE_SAMPLE_RATE = '0';
    await search();
    expect(judge).not.toHaveBeenCalled();
  });

  it('never judges an empty result', async () => {
    process.env.RAG_JUDGE_SAMPLE_RATE = '1';
    behavior.search_adobe_knowledge = () => ({ results: [] });
    await search();
    expect(judge).not.toHaveBeenCalled();
  });
});
