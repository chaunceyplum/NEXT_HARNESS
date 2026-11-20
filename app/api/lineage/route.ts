/**
 * GET /api/lineage?id=<object id>[&kind=<platform:object>][&limit=50]
 *
 * Which runs created, updated or deleted an Adobe object, newest first — e.g.
 * /api/lineage?id=seg-201&kind=adobe:segment answers "which run created this
 * segment, and what has touched it since?". Read from each run's stored
 * lineage (lib/run-store.ts findObjectHistory). A run's own changes are on its
 * record: GET /api/runs/:id → result.lineage.
 */

import { findObjectHistory } from '@/lib/run-store';
import { ApiError } from '@/lib/types';

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id')?.trim();
  if (!id) {
    return Response.json({ error: 'Missing "id" query parameter', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }
  const kind = searchParams.get('kind')?.trim() || undefined;
  const limit = Number(searchParams.get('limit')) || undefined;
  try {
    const history = await findObjectHistory({ id, ...(kind ? { kind } : {}), ...(limit ? { limit } : {}) });
    return Response.json({ id, ...(kind ? { kind } : {}), history }, { status: 200 });
  } catch (error) {
    console.error('[LINEAGE] Failed to read object history:', error);
    return Response.json(
      { error: `Failed to read object history: ${error instanceof Error ? error.message : String(error)}`, code: 'INTERNAL_ERROR' } as ApiError,
      { status: 500 }
    );
  }
}
