/**
 * Deployment memory (lib/memory-store.ts).
 *   GET    /api/memory                         → { facts }
 *   POST   /api/memory {key, value, note?}     → add or replace a fact
 *   DELETE /api/memory?key=…                   → remove a fact
 * Writes are limited to HARNESS_ADMINS when that's set.
 */

import { deleteFact, listFacts, saveFact } from '@/lib/memory-store';
import type { ApiError } from '@/lib/types';

function user(request: Request): string {
  return request.headers.get('x-harness-user') || 'anonymous';
}

function forbidden(request: Request): Response | undefined {
  const admins = process.env.HARNESS_ADMINS?.split(',').map((s) => s.trim()).filter(Boolean);
  const u = user(request);
  if (admins && admins.length > 0 && !admins.includes(u)) {
    return Response.json({ error: `"${u}" is not in HARNESS_ADMINS`, code: 'FORBIDDEN' } as ApiError, { status: 403 });
  }
  return undefined;
}

const unavailable = (err: unknown) =>
  Response.json({ error: err instanceof Error ? err.message : String(err), code: 'MEMORY_UNAVAILABLE' } as ApiError, { status: 502 });

export async function GET(): Promise<Response> {
  try {
    return Response.json({ facts: await listFacts() });
  } catch (err) {
    return unavailable(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = forbidden(request);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
  }
  if (typeof body.key !== 'string' || typeof body.value !== 'string') {
    return Response.json({ error: '"key" and "value" (strings) are required', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }
  try {
    const fact = await saveFact({
      key: body.key,
      value: body.value,
      note: typeof body.note === 'string' ? body.note : undefined,
      updatedBy: user(request),
    });
    return Response.json({ fact });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith('Not stored')
      ? Response.json({ error: message, code: 'VALIDATION_ERROR' } as ApiError, { status: 400 })
      : unavailable(err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = forbidden(request);
  if (denied) return denied;
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return Response.json({ error: '"key" query parameter is required', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  try {
    return (await deleteFact(key))
      ? Response.json({ deleted: key })
      : Response.json({ error: `No fact "${key}"`, code: 'NOT_FOUND' } as ApiError, { status: 404 });
  } catch (err) {
    return unavailable(err);
  }
}
