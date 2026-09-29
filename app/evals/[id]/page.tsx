'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, EvalRunDetail } from '@/lib/types';
import { EVAL_SUITE_LABELS, passRateClass } from '@/lib/eval-labels';

/** One eval run's fixture-by-fixture pass/fail, with the grader's notes on each. */
export default function EvalRunPage() {
  const params = useParams();
  const id = params.id as string;

  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/evals/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const errData: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` } as ApiError));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: EvalRunDetail) => setRun(data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load eval run'))
      .finally(() => setLoading(false));
  }, [id]);

  const rate = run && run.totalCount ? Math.round((run.passedCount / run.totalCount) * 100) : 0;
  const failuresFirst = run ? [...run.results].sort((a, b) => Number(a.passed) - Number(b.passed)) : [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <Link href="/evals" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
          ← All eval runs
        </Link>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        ) : run ? (
          <>
            <div className="bg-white rounded-lg shadow-lg p-6 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{EVAL_SUITE_LABELS[run.suite] ?? run.suite}</h1>
                  <p className="text-xs text-gray-500 font-mono mt-1">{run.id}</p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-sm font-bold ${passRateClass(
                    run.passedCount,
                    run.totalCount
                  )}`}
                >
                  {run.passedCount}/{run.totalCount} ({rate}%)
                </span>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div>
                  <dt className="inline text-gray-500">Graded: </dt>
                  <dd className="inline font-mono text-gray-900">{run.subject}</dd>
                </div>
                {run.judgeModel && (
                  <div>
                    <dt className="inline text-gray-500">Judge: </dt>
                    <dd className="inline font-mono text-gray-900">{run.judgeModel}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline text-gray-500">Started: </dt>
                  <dd className="inline text-gray-900">{new Date(run.startedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Duration: </dt>
                  <dd className="inline text-gray-900">
                    {((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)}s
                  </dd>
                </div>
              </dl>
            </div>

            <div className="bg-white rounded-lg shadow-lg divide-y divide-gray-100">
              {failuresFirst.map((r) => (
                <div key={r.fixtureId} className="p-4 space-y-1">
                  <div className="flex items-center justify-between gap-4">
                    <p className="font-mono text-sm text-gray-900 break-all">{r.fixtureId}</p>
                    <div className="shrink-0 flex items-center gap-2">
                      {r.totalTokens != null && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                          {r.totalTokens.toLocaleString()} tokens
                        </span>
                      )}
                      {r.durationMs != null && (
                        <span className="text-xs text-gray-500">{(r.durationMs / 1000).toFixed(1)}s</span>
                      )}
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                          r.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {r.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                  </div>
                  {r.notes && <p className="text-xs text-gray-600 whitespace-pre-wrap break-words">{r.notes}</p>}
                </div>
              ))}
              {run.results.length === 0 && (
                <p className="p-4 text-sm text-gray-500">No fixture results recorded for this run.</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
