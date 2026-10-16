import { listExecutions } from '@/lib/execution-store';
import type { RunSummary } from '@/lib/types';
import { ResultsList } from '@/components/ResultsList';

const PAGE_SIZE = 20;

// Runs accumulate in the DB over time; render at request time so the first
// page is always live, not frozen at build time (Cache Components is off, so
// an uncached DB read would otherwise be prerendered as static).
export const dynamic = 'force-dynamic';

/** Server component: fetches the first page, streams the shell immediately; client handles pagination. */
export default async function ResultsPage() {
  let initialRuns: RunSummary[] = [];
  let initialTotal = 0;
  try {
    const data = await listExecutions({ limit: PAGE_SIZE, offset: 0 });
    initialRuns = data.runs;
    initialTotal = data.total;
  } catch {
    // DB unavailable at render time — client component starts empty and will
    // show its own error if the user triggers a load-more.
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="pt-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Past Runs</h1>
          <p className="text-gray-500 text-sm mt-1">{initialTotal} recorded</p>
        </div>

        <ResultsList initialRuns={initialRuns} initialTotal={initialTotal} />
      </div>
    </div>
  );
}
