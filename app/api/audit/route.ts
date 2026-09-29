/**
 * GET /api/audit?runId=&actor=&tool=&type=&limit=&offset=
 *
 * Newest-first audit events (lib/audit-log.ts). HARNESS_ADMINS, when set,
 * limits this to those users, the same as the kill switch.
 */

import { listAudit, type AuditEventType } from '@/lib/audit-log';
import type { ApiError } from '@/lib/types';

const TYPES = new Set<AuditEventType>(['run_start', 'tool_call', 'approval', 'kill_switch']);

export async function GET(request: Request): Promise<Response> {
  const user = request.headers.get('x-harness-user') || 'anonymous';
  const admins = process.env.HARNESS_ADMINS?.split(',').map((s) => s.trim()).filter(Boolean);
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId') ?? undefined;
  // Anyone may read the audit trail of a single run (it's shown on the run
  // page); the unfiltered log is for admins when HARNESS_ADMINS is set.
  if (!runId && admins && admins.length > 0 && !admins.includes(user)) {
    return Response.json({ error: `"${user}" is not in HARNESS_ADMINS`, code: 'FORBIDDEN' } as ApiError, { status: 403 });
  }
  const type = url.searchParams.get('type');
  if (type && !TYPES.has(type as AuditEventType)) {
    return Response.json({ error: `Unknown type "${type}"`, code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }
  const num = (k: string) => {
    const v = Number(url.searchParams.get(k));
    return Number.isInteger(v) && v >= 0 ? v : undefined;
  };
  try {
    const events = await listAudit({
      runId,
      actor: url.searchParams.get('actor') ?? undefined,
      tool: url.searchParams.get('tool') ?? undefined,
      type: (type as AuditEventType | null) ?? undefined,
      limit: num('limit'),
      offset: num('offset'),
    });
    return Response.json({ events });
  } catch (err) {
    return Response.json(
      { error: `Could not read the audit log: ${err instanceof Error ? err.message : String(err)}`, code: 'AUDIT_UNAVAILABLE' } as ApiError,
      { status: 502 }
    );
  }
}
