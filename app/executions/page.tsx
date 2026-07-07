'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ExecutionSummary, ListExecutionsResponse, ApiError } from '@/lib/types';

const STATUS_BADGE: Record<string, string> = {
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  completed_with_errors: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-800',
};

export default function ExecutionsListPage() {
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchList() {
    try {
      const response = await fetch('/api/executions');
      if (!response.ok) {
        const errData: ApiError = await response.json().catch(() => ({ error: `HTTP ${response.status}` } as ApiError));
        setError(errData.error || `HTTP ${response.status}`);
        return;
      }
      const data: ListExecutionsResponse = await response.json();
      setExecutions(data.executions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch executions');
    }
  }

  useEffect(() => {
    fetchList();
    // Poll periodically so in-progress executions update without a manual
    // refresh. Cheap: this is a single lightweight summary fetch.
    pollRef.current = setInterval(fetchList, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Executions</h1>
            <p className="text-gray-600 text-sm mt-1">
              All builds started in this harness process.
            </p>
          </div>
          <Link
            href="/"
            className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors text-sm"
          >
            + New Build
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error loading executions</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {executions === null && !error && (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading executions...</p>
          </div>
        )}

        {executions !== null && executions.length === 0 && (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <p className="text-gray-600 mb-4">No executions yet.</p>
            <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium">
              Start your first build →
            </Link>
          </div>
        )}

        {executions !== null && executions.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase text-xs tracking-wide">
                  <th className="px-4 py-3 font-semibold">Description</th>
                  <th className="px-4 py-3 font-semibold">Domain / Vertical</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Progress</th>
                  <th className="px-4 py-3 font-semibold">Started</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {executions.map((exec) => (
                  <tr key={exec.execution_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-gray-900 truncate" title={exec.description}>
                        {exec.description}
                      </p>
                      <p className="text-gray-400 text-xs font-mono mt-0.5">{exec.execution_id}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <p>{exec.website_domain || '—'}</p>
                      <p className="text-gray-400 text-xs">{exec.business_vertical || ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold ${STATUS_BADGE[exec.status] || 'bg-gray-100 text-gray-600'}`}
                      >
                        {exec.status === 'running' && (
                          <span className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></span>
                        )}
                        {exec.status.replace(/_/g, ' ')}
                      </span>
                      {exec.planning_mode && (
                        <span
                          className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                            exec.planning_mode === 'llm' ? 'bg-violet-100 text-violet-700' : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {exec.planning_mode === 'llm' ? '✨ LLM' : 'heuristic'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 w-40">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-200 h-2 rounded-full overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-blue-500 to-indigo-600 h-2 rounded-full"
                            style={{ width: `${exec.progress * 100}%` }}
                          ></div>
                        </div>
                        <span className="text-gray-500 text-xs w-10 text-right">
                          {exec.completed_step_count}/{exec.step_count}
                        </span>
                      </div>
                      {exec.failed_step_count > 0 && (
                        <p className="text-red-500 text-xs mt-1">{exec.failed_step_count} failed</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {new Date(exec.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/executions/${exec.execution_id}`}
                        className="text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
