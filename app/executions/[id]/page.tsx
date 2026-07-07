'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { StatusResponse, StepResponse, ApiError } from '@/lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  rag: 'RAG',
  aep: 'AEP',
  cja: 'CJA',
  ajo: 'AJO',
};

const CATEGORY_COLORS: Record<string, string> = {
  rag: 'bg-purple-100 text-purple-700',
  aep: 'bg-blue-100 text-blue-700',
  cja: 'bg-teal-100 text-teal-700',
  ajo: 'bg-orange-100 text-orange-700',
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-600',
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  skipped: 'bg-yellow-100 text-yellow-800',
};

export default function ExecutionPage() {
  const params = useParams();
  const id = params.id as string;

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchStatus() {
    try {
      const response = await fetch(`/api/executions/${id}/status`);

      if (!response.ok) {
        const errData: ApiError = await response.json().catch(() => ({ error: `HTTP ${response.status}` } as ApiError));
        if (response.status === 404) {
          setError(errData.error || 'Execution not found');
        } else {
          setError(errData.error || `HTTP ${response.status}`);
        }
        setLoading(false);
        return;
      }

      const data: StatusResponse = await response.json();
      setStatus(data);
      setError(null);
      setLoading(false);

      const finished = data.status === 'completed' || data.status === 'failed' || data.status === 'completed_with_errors';
      if (finished && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch status';
      setError(message);
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Build Progress</h1>
            <p className="text-gray-600 text-sm mt-1">
              Execution ID: <code className="bg-gray-100 px-2 py-1 rounded">{id}</code>
            </p>
          </div>
          <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
            ← New Build
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {status && (
          <>
            {/* Overview card */}
            <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
                <div>
                  <p className="text-sm text-gray-600 font-medium">Current Step</p>
                  <p className="text-lg font-bold text-gray-900 mt-1">
                    {status.current_step || (status.status !== 'running' ? 'Done' : '—')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 font-medium">Status</p>
                  <div className="mt-1">
                    <span
                      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold ${
                        status.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : status.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : status.status === 'completed_with_errors'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {status.status === 'running' && (
                        <span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-2 animate-pulse"></span>
                      )}
                      {status.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-600 font-medium">Progress</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {(status.progress * 100).toFixed(0)}%
                  </p>
                </div>
              </div>

              <div className="w-full bg-gray-300 h-3 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-indigo-600 h-3 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${status.progress * 100}%` }}
                ></div>
              </div>
            </div>

            {status.error && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
                <p className="text-red-800 font-medium">Build Error</p>
                <p className="text-red-700 text-sm mt-2 font-mono whitespace-pre-wrap">{status.error}</p>
              </div>
            )}

            {/* Step list */}
            <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                Steps ({status.steps.filter((s) => s.status === 'completed').length}/{status.steps.length} completed)
              </h2>
              <ol className="space-y-3">
                {status.steps.map((step: StepResponse, i: number) => (
                  <li
                    key={step.id}
                    className="border border-gray-200 rounded-lg p-4 flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-sm text-gray-400 font-mono w-6 flex-shrink-0">{i + 1}.</span>
                        <span
                          className={`text-xs font-bold px-2 py-1 rounded flex-shrink-0 ${CATEGORY_COLORS[step.category] || 'bg-gray-100 text-gray-700'}`}
                        >
                          {CATEGORY_LABELS[step.category] || step.category.toUpperCase()}
                        </span>
                        <span className="font-medium text-gray-900 truncate">{step.label}</span>
                        {!step.critical && (
                          <span className="text-xs text-gray-400 flex-shrink-0">(optional)</span>
                        )}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold flex-shrink-0 ${STATUS_BADGE[step.status]}`}
                      >
                        {step.status === 'running' && (
                          <span className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></span>
                        )}
                        {step.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono pl-9">{step.tool}</p>
                    {step.error && (
                      <p className="text-xs text-red-600 pl-9 whitespace-pre-wrap break-words">
                        {step.error}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            {/* Resource manifest link */}
            {(status.status === 'completed' || status.status === 'completed_with_errors' || status.status === 'failed') && (
              <ResourceManifest executionId={id} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResourceManifest({ executionId }: { executionId: string }) {
  const [resources, setResources] = useState<any[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/executions/${executionId}/artifacts`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setResources(data.resources || []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [executionId]);

  if (loadError) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 rounded-lg">
        <p className="text-yellow-800 text-sm">Could not load resource manifest: {loadError}</p>
      </div>
    );
  }

  if (!resources) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-6 text-center text-gray-500 text-sm">
        Loading created resources...
      </div>
    );
  }

  if (resources.length === 0) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 rounded-lg">
        <p className="text-yellow-800 font-medium">No resources were created</p>
        <p className="text-yellow-700 text-sm mt-1">
          Every step failed or was skipped — check the step list above for details.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Created Resources ({resources.length})</h2>
      <p className="text-sm text-gray-500 mb-4">
        These are live resources created in the connected Adobe org via AEP / CJA / AJO — not downloadable files.
      </p>
      <div className="space-y-3">
        {resources.map((r: any, i: number) => (
          <details key={i} className="border border-gray-200 rounded-lg p-4">
            <summary className="cursor-pointer font-mono text-sm font-bold text-gray-900">
              {r.label}{' '}
              <span className="text-xs font-normal text-gray-400">({r.tool})</span>
            </summary>
            <pre className="mt-3 text-xs bg-gray-50 p-3 rounded overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(r.result, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}
