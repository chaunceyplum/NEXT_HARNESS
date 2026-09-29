/**
 * fetch() with a deadline. A tool call with no timeout hangs the whole agent
 * run on the one request that never answers (a stuck Lambda, a dropped
 * connection), so every outbound call in the tool path goes through this.
 *
 * The deadline covers reading the body too, as long as the caller reads it
 * before the timer fires. A caller-supplied signal (the run being stopped)
 * aborts the request as well; that surfaces as the caller's abort reason,
 * not as a timeout, so retry logic can tell "stop" from "slow".
 */

export class FetchTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s (timeout)`);
    this.name = 'FetchTimeoutError';
  }
}

/** Read a positive integer (ms) from the environment, falling back to `fallback`. */
export function envTimeoutMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; label: string; signal?: AbortSignal },
  read: (response: Response) => Promise<unknown> = async (r) => r
): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    const response = await fetch(url, { ...init, signal });
    return await read(response);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? err;
    if (timeout.aborted) throw new FetchTimeoutError(opts.label, opts.timeoutMs);
    throw err;
  }
}
