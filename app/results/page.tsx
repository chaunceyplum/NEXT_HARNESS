import Link from 'next/link';
import { listExecutions } from '@/lib/execution-store';
import type { RunSummary } from '@/lib/types';
import { ResultsList } from '@/components/ResultsList';

const PAGE_SIZE = 20;

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Past Runs</h1>
            <p className="text-gray-600 text-sm mt-1">{initialTotal} recorded</p>
          </div>
          <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
            ← New Request
          </Link>
        </div>

        <ResultsList initialRuns={initialRuns} initialTotal={initialTotal} />
      </div>
    </div>
  );
}
