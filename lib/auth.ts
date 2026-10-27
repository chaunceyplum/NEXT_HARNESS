/**
 * Who is making a request, and whether they may approve tool calls.
 *
 * The harness has no built-in authentication: the proxy.ts auth gate was
 * removed, so every page and API route is open to whoever can reach the app.
 * Deploy it on a private network or behind something that authenticates
 * (a VPN, an authenticating load balancer or reverse proxy).
 *
 * Route handlers take the caller's name from the x-harness-user header. Only
 * an authenticating proxy in front of the app should set it (and strip any
 * copy the client sent); without one the header is whatever the client sends.
 */

/** Request header carrying the caller's name, set by a proxy in front of the app. */
export const USER_HEADER = 'x-harness-user';

/** The caller's name from the x-harness-user header, or 'anonymous'. */
export function requestUser(request: Request): string {
  return request.headers.get(USER_HEADER) || 'anonymous';
}

/**
 * HARNESS_APPROVERS="alice,bob" limits who may approve or deny a paused
 * tool call. Unset means anyone may. It relies on x-harness-user, so it only
 * restricts anything when a proxy in front of the app sets that header.
 */
export function mayApprove(user: string, env: Record<string, string | undefined> = process.env): boolean {
  const list = env.HARNESS_APPROVERS?.split(',').map((s) => s.trim()).filter(Boolean);
  return !list || list.length === 0 || list.includes(user);
}
