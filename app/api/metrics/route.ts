/**
 * GET /api/metrics?days=7 — production agent metrics over the window
 * (lib/production-metrics.ts), for the /metrics page.
 */

import { computeProductionMetrics, loadProductionRuns } from '@/lib/production-metrics';
import type { ApiError } from '@/lib/types';

export async function GET(request: Request): Promise<Response> {
  const days = Number(new URL(request.url).searchParams.get('days') ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return Response.json({ error: '"days" must be an integer between 1 and 90', code: 'VALIDATION_ERROR' } as ApiError, { status: 400 });
  }
  try {
    const rows = await loadProductionRuns(days);
    return Response.json({ days, ...computeProductionMetrics(rows) });
  } catch (err) {
    return Response.json(
      { error: `Could not load runs: ${err instanceof Error ? err.message : String(err)}`, code: 'METRICS_UNAVAILABLE' } as ApiError,
      { status: 502 }
    );
  }
}
