'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { EvalRunSummary, EvalRunsListResponse, EvalSuite } from '@/lib/types';
import { EVAL_SUITE_LABELS, passRateClass } from '@/lib/eval-labels';

const PAGE_SIZE = 50;

/**
 * Every `npm run eval:*` invocation recorded in harness_eval_runs, newest
 * first. View-only: nothing here re-runs an eval or reaches a model — it
 * only reads what evals/lib/report.ts already wrote.
 */
export default function EvalsPage() {
  const [evalRuns, setEvalRuns] = useState<EvalRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [suite, setSuite] = useState<EvalSuite | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextOffset: number) {
    setLoading(true);
    try {
      const res = await fetch(`/api/evals?limit=${PAGE_SIZE}&offset=${nextOffset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: EvalRunsListResponse = await res.json();
      setEvalRuns((prev) => (nextOffset === 0 ? data.evalRuns : [...prev, ...data.evalRuns]));
      setTotal(data.total);
      setOffset(nextOffset);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load eval runs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = setTimeout(() => load(0), 0);
    return () => clearTimeout(initial);
  }, []);

  const visible = suite === 'all' ? evalRuns : evalRuns.filter((r) => r.suite === suite);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Evals</h1>
            <p className="text-gray-600 text-sm mt-1">
              {total} recorded · graded against hand-reviewed fixtures in <code className="text-xs">evals/</code>. Run
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

        <div className="flex flex-wrap gap-2">
          {(['all', ...Object.keys(EVAL_SUITE_LABELS)] as Array<EvalSuite | 'all'>).map((s) => (
            <button
              key={s}
              onClick={() => setSuite(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${
                suite === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {s === 'all' ? 'All suites' : EVAL_SUITE_LABELS[s]}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {loading && evalRuns.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
            No eval runs recorded yet. Run <code>npm run eval:all</code> with a model and MCP_ENDPOINT_URL configured.
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-lg divide-y divide-gray-100">
            {visible.map((run) => (
              <Link
                key={run.id}
                href={`/evals/${run.id}`}
                className="flex items-center justify-between gap-4 p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">{EVAL_SUITE_LABELS[run.suite] ?? run.suite}</p>
                  <p className="text-xs text-gray-500 mt-1 truncate">
                    {new Date(run.startedAt).toLocaleString()} · {run.subject}
                    {run.judgeModel ? ` · judged by ${run.judgeModel}` : ''}
                  </p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${passRateClass(
                    run.passedCount,
                    run.totalCount
                  )}`}
                >
                  {run.passedCount}/{run.totalCount} passed
                </span>
              </Link>
            ))}
          </div>
        )}

        {!loading && evalRuns.length < total && (
          <div className="text-center">
            <button
              onClick={() => load(offset + PAGE_SIZE)}
              className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
