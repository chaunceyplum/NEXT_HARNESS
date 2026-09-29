/**
 * GET  /api/runs/:id/feedback — the run's quality signals: user rating and,
 *      if it was sampled, the online judge's grade (lib/run-quality.ts)
 * POST /api/runs/:id/feedback — {"rating": 1 | -1, "comment"?: string}
 *      A 👎 counts the run as unsuccessful in /metrics and puts it in the
 *      review queue there.
 */

import { getQuality, saveFeedback } from '@/lib/run-quality';
import type { ApiError } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  try {
    return Response.json((await getQuality(id)) ?? { runId: id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err), code: 'QUALITY_UNAVAILABLE' } as ApiError, { status: 502 });
  }
}

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body', code: 'INVALID_JSON' } as ApiError, { status: 400 });
  }
  if (body.rating !== 1 && body.rating !== -1) {
    return Response.json({ error: '"rating" must be 1 or -1', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }
  const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 2_000) : undefined;
  const user = request.headers.get('x-harness-user') || 'anonymous';
  try {
    await saveFeedback(id, body.rating, comment, user);
    return Response.json(await getQuality(id));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err), code: 'QUALITY_UNAVAILABLE' } as ApiError, { status: 502 });
  }
}
