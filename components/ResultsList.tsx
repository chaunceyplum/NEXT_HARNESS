'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RunSummary, RunsListResponse } from '@/lib/types';

const PAGE_SIZE = 20;

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  running: 'bg-blue-100 text-blue-800',
  interrupted: 'bg-amber-100 text-amber-800',
};

export function ResultsList({ initialRuns, initialTotal }: { initialRuns: RunSummary[]; initialTotal: number }) {
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(initialRuns.length);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    setLoading(true);
    try {
      const res = await fetch(`/api/runs?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RunsListResponse = await res.json();
      setRuns((prev) => [...prev, ...data.runs]);
      setTotal(data.total);
      setOffset((prev) => prev + data.runs.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
          <p className="text-red-800 font-medium">Error</p>
          <p className="text-red-700 text-sm mt-1">{error}</p>
        </div>
      )}

      {runs.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          No runs recorded yet. Go run something from the home page.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-lg divide-y divide-gray-100">
          {runs.map((run) => (
            <Link
              key={run.id}
              href={`/results/${run.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-gray-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{run.description}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(run.createdAt).toLocaleString()} · {run.model} ·{' '}
                  {(run.durationMs / 1000).toFixed(1)}s
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {run.usage?.totalTokens != null && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800">
                    {run.usage.totalTokens.toLocaleString()} tokens
                  </span>
                )}
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${
                    STATUS_BADGE[run.status] ?? 'bg-red-100 text-red-800'
                  }`}
                >
                  {run.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && runs.length < total && (
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
