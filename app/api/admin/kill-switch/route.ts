/**
 * GET  /api/admin/kill-switch — {engaged, source?, at?, by?, reason?, activeRuns[]}
 * POST /api/admin/kill-switch — {"engaged":true,"reason":"..."} aborts every
 *      active run and refuses new ones; {"engaged":false} releases a
 *      runtime switch (AGENT_DISABLED=true can only be lifted in the env).
 *
 * HARNESS_ADMINS="alice,bob" limits POST to those users (the name comes
 * from the x-harness-user header set by the auth proxy). Unset: any caller.
 */

import { engageKillSwitch, killSwitchStatus, releaseKillSwitch } from '@/lib/kill-switch';
import type { ApiError } from '@/lib/types';
import { recordAudit } from '@/lib/audit-log';

function caller(request: Request): string {
  return request.headers.get('x-harness-user') || 'anonymous';
}

function isAdmin(user: string): boolean {
  const admins = process.env.HARNESS_ADMINS?.split(',').map((s) => s.trim()).filter(Boolean);
  return !admins || admins.length === 0 || admins.includes(user);
}

export async function GET(): Promise<Response> {
  return Response.json(killSwitchStatus());
}

export async function POST(request: Request): Promise<Response> {
  const user = caller(request);
  if (!isAdmin(user)) {
    return Response.json({ error: `"${user}" is not in HARNESS_ADMINS`, code: 'FORBIDDEN' } as ApiError, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
  }
  if (typeof body.engaged !== 'boolean') {
    return Response.json({ error: '"engaged" (boolean) is required', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }

  if (body.engaged) {
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
    const aborted = engageKillSwitch(user, reason);
    console.warn(`[KILL-SWITCH] Engaged by ${user}${reason ? ` (${reason})` : ''}; aborted ${aborted} run(s).`);
    void recordAudit([{ type: 'kill_switch', actor: user, outcome: 'engaged', input: { reason, aborted } }]);
    return Response.json({ ...killSwitchStatus(), aborted });
  }

  if (killSwitchStatus().source === 'env') {
    return Response.json(
      { error: 'AGENT_DISABLED=true is set in the environment; remove it and restart to re-enable the agent.', code: 'ENV_LOCKED' } as ApiError,
      { status: 409 }
    );
  }
  releaseKillSwitch();
  console.warn(`[KILL-SWITCH] Released by ${user}.`);
  void recordAudit([{ type: 'kill_switch', actor: user, outcome: 'released' }]);
  return Response.json(killSwitchStatus());
}
