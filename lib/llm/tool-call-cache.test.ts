import { beforeEach, describe, expect, it, vi } from 'vitest';

// Write safety (no ambiguous retries, per-run de-duplication) and the read
// cache, through executeMcpToolWithRetry against a scripted MCP client.

const calls: string[] = [];
const behavior: Record<string, () => unknown> = {};

vi.mock('@/lib/mcp-client', () => ({
  callMcpTool: async (tool: string) => {
    calls.push(tool);
    return behavior[tool]();
  },
  listMcpTools: async () => ({ tools: [] }),
}));

const { executeMcpToolWithRetry, createGroundingState } = await import('./tool-catalog');
const { cachedRead, invalidateReadCache, isRejectedBeforeExecution, WriteDeduper } = await import('./tool-call-cache');

const run = (tool: string, args: Record<string, unknown> = {}, deduper = new WriteDeduper()) =>
  executeMcpToolWithRetry(tool, args, { maxRetries: 2, availableNames: new Set(), grounding: createGroundingState(), deduper });

beforeEach(() => {
  calls.length = 0;
  invalidateReadCache();
  delete process.env.READ_CACHE_TTL_MS;
});

describe('isRejectedBeforeExecution', () => {
  it('recognises refusals, not ambiguous failures', () => {
    for (const m of ['HTTP 429: Too Many Requests', 'HTTP 503: Service Unavailable', 'connect ECONNREFUSED 10.0.0.1:443', 'Rate limit exceeded']) {
      expect(isRejectedBeforeExecution(m), m).toBe(true);
    }
    for (const m of ['MCP tool x timed out after 60s (timeout)', 'HTTP 500: Internal Server Error', 'HTTP 504: Gateway Timeout', 'socket hang up']) {
      expect(isRejectedBeforeExecution(m), m).toBe(false);
    }
  });
});

describe('write retries', () => {
  it('does not retry a write after an ambiguous failure, and says why', async () => {
    behavior.adobe_create_segment = () => {
      throw new Error('HTTP 504: Gateway Timeout');
    };
    await expect(run('adobe_create_segment', { name: 's' })).rejects.toThrow(/NOT retried automatically/);
    expect(calls).toEqual(['adobe_create_segment']);
  });

  it('retries a write the server refused outright', async () => {
    let n = 0;
    behavior.adobe_create_segment = () => {
      if (n++ === 0) throw new Error('HTTP 503: Service Unavailable');
      return { id: 'seg-1' };
    };
    await expect(run('adobe_create_segment', { name: 's' })).resolves.toMatchObject({ id: 'seg-1' });
    expect(calls).toHaveLength(2);
  });

  it('still retries a read after an ambiguous failure', async () => {
    let n = 0;
    behavior.adobe_list_segments = () => {
      if (n++ === 0) throw new Error('HTTP 500: Internal Server Error');
      return { items: [] };
    };
    await expect(run('adobe_list_segments')).resolves.toMatchObject({ items: [] });
    expect(calls).toHaveLength(2);
  });
});

describe('write de-duplication', () => {
  it('does not send an identical successful write twice in one run', async () => {
    behavior.adobe_create_segment = () => ({ id: 'seg-1' });
    const deduper = new WriteDeduper();
    await run('adobe_create_segment', { name: 's', pql: 'x' }, deduper);
    const second = await run('adobe_create_segment', { pql: 'x', name: 's' }, deduper);
    expect(calls).toEqual(['adobe_create_segment']);
    expect(second).toMatchObject({ _duplicateSuppressed: true, earlierResult: { id: 'seg-1' } });
  });

  it('sends writes with different arguments, and identical writes in another run', async () => {
    behavior.adobe_create_segment = () => ({ id: 'seg' });
    const deduper = new WriteDeduper();
    await run('adobe_create_segment', { name: 'a' }, deduper);
    await run('adobe_create_segment', { name: 'b' }, deduper);
    await run('adobe_create_segment', { name: 'a' });
    expect(calls).toHaveLength(3);
  });
});

describe('read cache', () => {
  it('serves an identical read from cache, and a write clears it', async () => {
    behavior.adobe_list_segments = () => ({ items: calls.length });
    behavior.adobe_create_segment = () => ({ id: 'x' });
    await run('adobe_list_segments', { limit: 5 });
    await run('adobe_list_segments', { limit: 5 });
    expect(calls).toEqual(['adobe_list_segments']);

    await run('adobe_create_segment', { name: 'new' });
    await run('adobe_list_segments', { limit: 5 });
    expect(calls).toEqual(['adobe_list_segments', 'adobe_create_segment', 'adobe_list_segments']);
  });

  it('never caches credential reads', async () => {
    behavior.flow_get_landing_zone_credentials = () => ({ token: 't' });
    await run('flow_get_landing_zone_credentials');
    await run('flow_get_landing_zone_credentials');
    expect(calls).toHaveLength(2);
  });

  it('expires entries, does not cache failures, and can be disabled', async () => {
    const fetch = vi.fn(async () => 'v');
    await cachedRead('t', {}, fetch, 0);
    await cachedRead('t', {}, fetch, 59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cachedRead('t', {}, fetch, 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(cachedRead('f', {}, failing, 0)).rejects.toThrow('boom');
    await expect(cachedRead('f', {}, failing, 1)).rejects.toThrow('boom');
    expect(failing).toHaveBeenCalledTimes(2);

    process.env.READ_CACHE_TTL_MS = '0';
    const direct = vi.fn(async () => 'v');
    await cachedRead('d', {}, direct);
    await cachedRead('d', {}, direct);
    expect(direct).toHaveBeenCalledTimes(2);
  });
});
