import { listEvalRuns } from '@/lib/eval-store';
import type { EvalRunSummary } from '@/lib/types';
import { EvalsList } from '@/components/EvalsList';

const PAGE_SIZE = 50;

// Eval runs accumulate in the DB over time; render at request time so the first
// page is always live, not frozen at build time (Cache Components is off, so
// an uncached DB read would otherwise be prerendered as static).
export const dynamic = 'force-dynamic';

/** Server component: fetches the first page, streams the shell immediately; client handles suite filtering and pagination. */
export default async function EvalsPage() {
  let initialEvalRuns: EvalRunSummary[] = [];
  let initialTotal = 0;
  try {
    const data = await listEvalRuns({ limit: PAGE_SIZE, offset: 0 });
    initialEvalRuns = data.evalRuns;
    initialTotal = data.total;
  } catch {
    // DB unavailable — client component will show an empty state.
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="pt-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Evals</h1>
          <p className="text-gray-500 text-sm mt-1">
            {initialTotal} recorded · graded against hand-reviewed fixtures in <code className="text-xs">evals/</code>. Run
            with <code className="text-xs">npm run eval:all</code>.
          </p>
        </div>

        <EvalsList initialEvalRuns={initialEvalRuns} initialTotal={initialTotal} />
      </div>
    </div>
  );
}
