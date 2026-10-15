import Link from 'next/link';
import { listEvalRuns } from '@/lib/eval-store';
import type { EvalRunSummary } from '@/lib/types';
import { EvalsList } from '@/components/EvalsList';

const PAGE_SIZE = 50;

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Evals</h1>
            <p className="text-gray-600 text-sm mt-1">
              {initialTotal} recorded · graded against hand-reviewed fixtures in <code className="text-xs">evals/</code>. Run
              with <code className="text-xs">npm run eval:all</code>.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              ← New Request
            </Link>
            <Link href="/results" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              Past runs →
            </Link>
          </div>
        </div>

        <EvalsList initialEvalRuns={initialEvalRuns} initialTotal={initialTotal} />
      </div>
    </div>
  );
}
