import { beforeEach, describe, expect, it, vi } from 'vitest';

// Retry timing and cancellation in executeMcpToolWithRetry.

const calls: Array<{ tool: string; signal?: AbortSignal }> = [];
let behavior: () => unknown = () => ({ ok: true });

vi.mock('@/lib/mcp-client', () => ({
  callMcpTool: async (tool: string, _args: unknown, opts: { signal?: AbortSignal } = {}) => {
    calls.push({ tool, signal: opts.signal });
    return behavior();
  },
  listMcpTools: async () => ({ tools: [] }),
}));

const { executeMcpToolWithRetry, retryDelayMs } = await import('./tool-catalog');
const { invalidateReadCache } = await import('./tool-call-cache');

beforeEach(() => {
  calls.length = 0;
  // The read cache is process-wide; clear it so identical reads across these
  // tests aren't served from a prior test's cached result.
  invalidateReadCache();
});

describe('retryDelayMs', () => {
  it('backs off exponentially with jitter between 50% and 100% of the ceiling', () => {
    expect(retryDelayMs(1, 'HTTP 503', () => 0)).toBe(250);
    expect(retryDelayMs(1, 'HTTP 503', () => 1)).toBe(500);
    expect(retryDelayMs(3, 'HTTP 503', () => 1)).toBe(2_000);
    expect(retryDelayMs(1, 'HTTP 429 Too Many Requests', () => 1)).toBe(2_000);
    for (let i = 0; i < 50; i++) {
      const d = retryDelayMs(2, 'HTTP 503');
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1_000);
    }
  });
});

describe('executeMcpToolWithRetry cancellation', () => {
  it('passes the abort signal to the MCP request', async () => {
    const controller = new AbortController();
    await executeMcpToolWithRetry('adobe_list_segments', {}, { maxRetries: 1, availableNames: new Set(), abortSignal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('does not retry once the run is stopped', async () => {
    const controller = new AbortController();
    behavior = () => {
      controller.abort(new Error('run stopped'));
      throw new Error('run stopped');
    };
    await expect(
      executeMcpToolWithRetry('adobe_list_segments', {}, { maxRetries: 3, availableNames: new Set(), abortSignal: controller.signal })
    ).rejects.toThrow('run stopped');
    expect(calls).toHaveLength(1);
  });

  it('retries a timeout as a transient failure', async () => {
    let n = 0;
    behavior = () => {
      if (n++ === 0) throw new Error('MCP tool adobe_list_segments timed out after 60s (timeout)');
      return { ok: true };
    };
    const out = await executeMcpToolWithRetry('adobe_list_segments', {}, { maxRetries: 1, availableNames: new Set() });
    expect(out).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });
});
