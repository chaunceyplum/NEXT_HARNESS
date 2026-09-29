/**
 * Side-effect safety and caching for tool calls.
 *
 *   Writes: a retry is only safe when the server certainly didn't act on the
 *   first attempt. isRejectedBeforeExecution() recognises those errors (rate
 *   limits, 503, refused connections); anything else transient — a timeout,
 *   a 500/502/504, a dropped connection — may have landed, so a write/
 *   destructive call is not retried after it (see executeMcpToolWithRetry).
 *   And within one run an identical write that already succeeded isn't sent
 *   again (WriteDeduper): the model gets the earlier result back.
 *
 *   Reads: identical read calls within READ_CACHE_TTL_MS (default 60s) share
 *   one result, process-wide. Any write through this process clears the
 *   cache, so a run never reads back its own stale state.
 */

/** Stable JSON: object keys sorted, so {a,b} and {b,a} are the same call. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function callKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`;
}

const REJECTED_BEFORE_EXECUTION = [
  /(?:^\s*|\b(?:status|code|http|error)\W{0,3})(?:429|503)\b/i,
  /too many requests/i,
  /rate.?limit/i,
  /service unavailable/i,
  /ECONNREFUSED/,
  /ENOTFOUND|EAI_AGAIN/,
  /throttl/i,
];

/** The server refused the request outright, so it did nothing and a retry can't duplicate an effect. */
export function isRejectedBeforeExecution(message: string): boolean {
  return REJECTED_BEFORE_EXECUTION.some((re) => re.test(message));
}

/** Per-run memory of successful writes, so an identical write isn't executed twice. */
export class WriteDeduper {
  private readonly done = new Map<string, unknown>();

  get(toolName: string, args: unknown): { hit: true; result: unknown } | { hit: false } {
    const key = callKey(toolName, args);
    return this.done.has(key) ? { hit: true, result: this.done.get(key) } : { hit: false };
  }

  record(toolName: string, args: unknown, result: unknown): void {
    this.done.set(callKey(toolName, args), result);
  }
}

export function duplicateWriteResult(toolName: string, earlier: unknown): unknown {
  return {
    _duplicateSuppressed: true,
    message:
      `${toolName} was already called with exactly these arguments earlier in this run and succeeded, so it was not sent again. ` +
      'The earlier result is below. If you really need a second, separate change, call it with different arguments.',
    earlierResult: earlier,
  };
}

// ── Read cache ────────────────────────────────────────────────────────────────

const DEFAULT_READ_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

interface Entry {
  expires: number;
  value: Promise<unknown>;
}

const readCache: Map<string, Entry> = ((globalThis as { __harnessReadCache?: Map<string, Entry> }).__harnessReadCache ??=
  new Map());

function ttlMs(): number {
  const raw = process.env.READ_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_READ_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_READ_CACHE_TTL_MS;
}

/**
 * Return a cached result for this read, or run `fetch` and cache it.
 * Concurrent identical reads share one in-flight request. Failures aren't
 * cached. READ_CACHE_TTL_MS=0 disables caching.
 */
export async function cachedRead(toolName: string, args: unknown, fetch: () => Promise<unknown>, now = Date.now()): Promise<unknown> {
  const ttl = ttlMs();
  if (ttl === 0) return fetch();
  const key = callKey(toolName, args);
  const hit = readCache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const value = fetch();
  readCache.set(key, { expires: now + ttl, value });
  value.catch(() => {
    if (readCache.get(key)?.value === value) readCache.delete(key);
  });
  if (readCache.size > MAX_ENTRIES) {
    for (const [k, e] of readCache) {
      if (e.expires <= now || readCache.size > MAX_ENTRIES) readCache.delete(k);
      if (readCache.size <= MAX_ENTRIES) break;
    }
  }
  return value;
}

/** Drop every cached read — called after any write, since it may have changed what a read returns. */
export function invalidateReadCache(): void {
  readCache.clear();
}
