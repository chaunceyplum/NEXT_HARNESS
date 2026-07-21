'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RunSummary, RunsListResponse } from '@/lib/types';
import { statusBadgeClass } from '@/lib/status-badge';

const PAGE_SIZE = 20;

export default function ResultsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextOffset: number) {
    setLoading(true);
    try {
      const res = await fetch(`/api/runs?limit=${PAGE_SIZE}&offset=${nextOffset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RunsListResponse = await res.json();
      setRuns((prev) => (nextOffset === 0 ? data.runs : [...prev, ...data.runs]));
      setTotal(data.total);
      setOffset(nextOffset);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = setTimeout(() => load(0), 0);
    return () => clearTimeout(initial);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Past Runs</h1>
            <p className="text-gray-600 text-sm mt-1">{total} recorded</p>
          </div>
          <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
            ← New Request
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {loading && runs.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        ) : runs.length === 0 ? (
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
                    {new Date(run.createdAt).toLocaleString()} · {run.model}
                    {run.allowFullBuild && ' · full build'}
                    {' · '}
                    {(run.durationMs / 1000).toFixed(1)}s
                  </p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${statusBadgeClass(run.status)}`}
                >
                  {run.status}
                </span>
              </Link>
            ))}
          </div>
        )}

        {!loading && runs.length < total && (
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
