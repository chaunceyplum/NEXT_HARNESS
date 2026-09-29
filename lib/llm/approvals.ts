/**
 * In-process registry of destructive tool calls waiting on a human decision.
 *
 * /api/build's approval hook (lib/llm/agent.ts → RunAgentOptions.approveTool)
 * registers a pending call here and streams an `approval_request` event;
 * the page POSTs the decision to /api/build/approve, which resolves it. The
 * agent's step loop is simply awaiting the promise in between, so no run
 * state has to be persisted or resumed.
 *
 * Pending approvals live in this process's memory: this relies on the app
 * running as a single Node process (next dev / the standalone Docker image),
 * and a pending call is denied if the run is aborted or times out.
 */

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  /** The user who decided; absent when the call timed out or the run was cancelled. */
  decidedBy?: string;
}

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
}

/** How long a destructive call waits for a decision before it's denied. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// Kept on globalThis so Next's dev-mode module reloading doesn't split the
// map between the /api/build and /api/build/approve route bundles.
const registry: Map<string, Pending> = ((globalThis as { __harnessApprovals?: Map<string, Pending> }).__harnessApprovals ??=
  new Map());

const key = (runId: string, toolCallId: string) => `${runId}:${toolCallId}`;

function timeoutMs(): number {
  const v = Number(process.env.APPROVAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * Wait for a human to approve or deny one tool call. Resolves (never
 * rejects) — to a denial on timeout or when `signal` aborts.
 */
export function waitForApproval(runId: string, toolCallId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
  const k = key(runId, toolCallId);
  return new Promise<ApprovalDecision>((resolve) => {
    const finish = (decision: ApprovalDecision) => {
      if (!registry.has(k)) return;
      registry.delete(k);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = () => finish({ approved: false, reason: 'Run was cancelled before this call was approved.' });
    const ms = timeoutMs();
    const timer = setTimeout(
      () => finish({ approved: false, reason: `No approval decision within ${Math.round(ms / 1000)}s.` }),
      ms
    );

    registry.set(k, { resolve: finish });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Record a decision for a pending call. Returns false if nothing was waiting on it. */
export function resolveApproval(runId: string, toolCallId: string, approved: boolean, user?: string): boolean {
  const pending = registry.get(key(runId, toolCallId));
  if (!pending) return false;
  const who = user ? `"${user}"` : 'the user';
  pending.resolve({ approved, reason: approved ? `Approved by ${who}.` : `Denied by ${who}.`, ...(user ? { decidedBy: user } : {}) });
  return true;
}
