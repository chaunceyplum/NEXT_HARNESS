'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { EvalRunSummary, EvalRunsListResponse, EvalSuite } from '@/lib/types';
import { EVAL_SUITE_LABELS, passRateClass, pct } from '@/lib/eval-labels';

const PAGE_SIZE = 50;

export function EvalsList({ initialEvalRuns, initialTotal }: { initialEvalRuns: EvalRunSummary[]; initialTotal: number }) {
  const [evalRuns, setEvalRuns] = useState<EvalRunSummary[]>(initialEvalRuns);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(initialEvalRuns.length);
  const [suite, setSuite] = useState<EvalSuite | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    setLoading(true);
    try {
      const res = await fetch(`/api/evals?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: EvalRunsListResponse = await res.json();
      setEvalRuns((prev) => [...prev, ...data.evalRuns]);
      setTotal(data.total);
      setOffset((prev) => prev + data.evalRuns.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load eval runs');
    } finally {
      setLoading(false);
    }
  }

  const visible = useMemo(
    () => (suite === 'all' ? evalRuns : evalRuns.filter((r) => r.suite === suite)),
    [evalRuns, suite]
  );

  return (
    <>
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

      {visible.length === 0 ? (
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
              <div className="shrink-0 flex items-center gap-2">
                {run.metrics && run.trialsPerFixture > 1 && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800">
                    pass^{run.trialsPerFixture} {pct(run.metrics.passHatK)}
                  </span>
                )}
                {run.metrics && run.metrics.safetyViolations > 0 && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-red-600 text-white">
                    {run.metrics.safetyViolations} safety
                  </span>
                )}
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${passRateClass(
                    run.passedCount,
                    run.totalCount
                  )}`}
                >
                  {run.passedCount}/{run.totalCount} trials passed
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && evalRuns.length < total && (
        <div className="text-center">
          <button
            onClick={loadMore}
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Load more
          </button>
        </div>
      )}
      {loading && (
        <p className="text-center text-gray-500 text-sm">Loading…</p>
      )}
    </>
  );
}
