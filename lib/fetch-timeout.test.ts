import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTimeoutError, fetchWithTimeout } from './fetch-timeout';

/** A fetch that never answers, but rejects when its signal aborts — like a hung connection. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  it('turns a hung request into a labelled timeout error', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    await expect(fetchWithTimeout('http://x', {}, { timeoutMs: 20, label: 'MCP tool slow_tool' })).rejects.toThrow(
      /MCP tool slow_tool timed out after 0s/
    );
    await expect(fetchWithTimeout('http://x', {}, { timeoutMs: 20, label: 'x' })).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it('reports a caller abort as the abort, not a timeout', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const pending = fetchWithTimeout('http://x', {}, { timeoutMs: 10_000, label: 'x', signal: controller.signal });
    controller.abort(new Error('run stopped'));
    await expect(pending).rejects.toThrow('run stopped');
  });

  it('passes a response through the reader', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    const out = await fetchWithTimeout('http://x', {}, { timeoutMs: 1_000, label: 'x' }, (r) => r.json());
    expect(out).toEqual({ ok: true });
  });
});
