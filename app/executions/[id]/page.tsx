'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, Artifact, ExecutionStatus } from '@/lib/types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export default function ExecutionPage() {
  const params = useParams();
  const id = params.id as string;

  const [status, setStatus] = useState<ExecutionStatus | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  async function fetchStatus() {
    try {
      const response = await fetch(`/api/executions/${id}/status`);

      if (!response.ok) {
        if (response.status === 404) {
          setError('Execution not found');
          setIsPolling(false);
          setLoading(false);
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data: ExecutionStatus = await response.json();
      setStatus(data);
      setError(null);

      const isTerminal = typeof data.status === 'string' && TERMINAL_STATUSES.has(data.status);
      if (isTerminal) {
        setIsPolling(false);
        if (data.status === 'COMPLETED') fetchArtifacts();
      }

      setLoading(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch status';
      setError(errorMessage);
      console.error('Status fetch error:', err);
      setLoading(false);
    }
  }

  async function fetchArtifacts() {
    try {
      const response = await fetch(`/api/executions/${id}/artifacts`);
      if (!response.ok) return;
      const data: { artifacts: Artifact[] } = await response.json();
      setArtifacts(data.artifacts || []);
    } catch (err) {
      console.error('Artifacts fetch error:', err);
    }
  }

  async function handleCancel() {
    setActionPending(true);
    try {
      const res = await fetch(`/api/executions/${id}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const errData: ApiError = await res.json();
        throw new Error(errData.error || 'Cancel failed');
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setActionPending(false);
    }
  }

  async function handleResume() {
    setActionPending(true);
    try {
      const res = await fetch(`/api/executions/${id}/resume`, { method: 'POST' });
      if (!res.ok) {
        const errData: ApiError = await res.json();
        throw new Error(errData.error || 'Resume failed');
      }
      setIsPolling(true);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setActionPending(false);
    }
  }

  useEffect(() => {
    // Deferred so the fetch (and its setState calls) run outside the
    // synchronous effect body rather than during React's commit phase.
    const initial = setTimeout(fetchStatus, 0);
    if (!isPolling) return () => clearTimeout(initial);
    const interval = setInterval(fetchStatus, 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isPolling]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [status?.logs]);

  if (loading && !status) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading execution status...</p>
          </div>
        </div>
      </div>
    );
  }

  const canCancel = status?.status && !TERMINAL_STATUSES.has(status.status);
  const canResume = status?.status === 'FAILED';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Build Progress</h1>
            <p className="text-gray-600 text-sm mt-1">
              Execution ID: <code className="bg-gray-100 px-2 py-1 rounded">{id}</code>
            </p>
          </div>
          <div className="flex items-center gap-4">
            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={actionPending}
                className="text-red-600 hover:text-red-700 font-medium text-sm disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            {canResume && (
              <button
                onClick={handleResume}
                disabled={actionPending}
                className="text-blue-600 hover:text-blue-700 font-medium text-sm disabled:opacity-50"
              >
                Resume
              </button>
            )}
            <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              ← New Request
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {status && (
          <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
              <div>
                <p className="text-sm text-gray-600 font-medium">Current Phase</p>
                <p className="text-lg font-bold text-gray-900 mt-1">{status.current_phase ?? '—'}</p>
                {status.phase_number != null && status.total_phases != null && (
                  <p className="text-xs text-gray-500 mt-1">
                    Phase {status.phase_number} of {status.total_phases}
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm text-gray-600 font-medium">Status</p>
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold ${
                      status.status === 'COMPLETED'
                        ? 'bg-green-100 text-green-800'
                        : status.status === 'FAILED'
                        ? 'bg-red-100 text-red-800'
                        : status.status === 'RUNNING'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {status.status === 'RUNNING' && (
                      <span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-2 animate-pulse"></span>
                    )}
                    {status.status ?? 'UNKNOWN'}
                  </span>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-600 font-medium">Progress</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {status.progress != null ? `${(status.progress * 100).toFixed(0)}%` : '—'}
                </p>
              </div>
            </div>

            {status.progress != null && (
              <div className="w-full bg-gray-300 h-3 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-indigo-600 h-3 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${status.progress * 100}%` }}
                ></div>
              </div>
            )}
          </div>
        )}

        {status?.logs && status.logs.length > 0 && (
          <div className="bg-gray-900 rounded-lg shadow-lg overflow-hidden">
            <div className="bg-gray-800 px-4 py-3 border-b border-gray-700">
              <p className="text-white font-mono text-sm">Build Log</p>
            </div>
            <div className="p-4 font-mono text-sm text-green-400 max-h-96 overflow-y-auto bg-gray-900">
              {status.logs.map((log: string, i: number) => (
                <div key={i} className="whitespace-pre-wrap break-words">
                  {log}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}

        {status?.error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Build Error</p>
            <p className="text-red-700 text-sm mt-2 font-mono whitespace-pre-wrap">{status.error}</p>
          </div>
        )}

        {artifacts && artifacts.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Generated Artifacts</h2>
            <div className="space-y-3">
              {artifacts.map((artifact, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div>
                    <p className="font-mono text-sm font-bold text-gray-900">
                      {artifact.filename ?? `artifact-${i}`}
                    </p>
                    <div className="flex gap-3 mt-1 text-xs text-gray-500">
                      {artifact.type && (
                        <span className="inline-block px-2 py-1 bg-blue-100 text-blue-700 rounded">
                          {String(artifact.type).toUpperCase()}
                        </span>
                      )}
                      {artifact.size_bytes != null && <span>{(artifact.size_bytes / 1024).toFixed(1)} KB</span>}
                    </div>
                  </div>
                  {artifact.content != null && (
                    <button
                      onClick={() => {
                        const element = document.createElement('a');
                        element.setAttribute(
                          'href',
                          `data:text/plain;charset=utf-8,${encodeURIComponent(String(artifact.content))}`
                        );
                        element.setAttribute('download', artifact.filename ?? `artifact-${i}.txt`);
                        element.style.display = 'none';
                        document.body.appendChild(element);
                        element.click();
                        document.body.removeChild(element);
                      }}
                      className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded hover:bg-blue-700 transition-colors"
                    >
                      Download
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {status?.status === 'COMPLETED' && (!artifacts || artifacts.length === 0) && (
          <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-lg">
            <p className="text-green-800 font-medium">Build Complete</p>
            <p className="text-green-700 text-sm mt-1">
              No downloadable artifacts were reported for this execution.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
