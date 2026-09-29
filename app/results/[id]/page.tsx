'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, BuildResponse, ExecutionRecord } from '@/lib/types';
import AgentTrace from '@/components/AgentTrace';
import RunFeedback from '@/components/RunFeedback';
import AuditTrail from '@/components/AuditTrail';

/** Status badge colors; the badge text always carries the status too. */
const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  running: 'bg-blue-100 text-blue-800',
  interrupted: 'bg-amber-100 text-amber-800',
};

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [resuming, setResuming] = useState(false);

  /** Start the continuation run, then follow it live on the home page. */
  async function handleResume() {
    setResuming(true);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      const newId = res.headers.get('X-Run-Id');
      if (!res.ok || !newId) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      // The run continues on the server; the home page reattaches to it.
      await res.body?.cancel();
      router.push(`/?run=${newId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResuming(false);
    }
  }
  const id = params.id as string;

  const [record, setRecord] = useState<ExecutionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    fetch(`/api/runs/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const errData: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` } as ApiError));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: ExecutionRecord) => setRecord(data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load run'))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleReplay() {
    if (!record) return;
    setReplaying(true);
    setError(null);
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record.request),
      });

      if (!res.ok) {
        const errData: ApiError = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data: BuildResponse = await res.json();
      router.push(`/results/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed');
      setReplaying(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading run...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Run Detail</h1>
            <p className="text-gray-600 text-sm mt-1">
              <code className="bg-white px-2 py-0.5 rounded">{id}</code>
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleReplay}
              disabled={!record || replaying}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {replaying ? 'Replaying...' : 'Replay'}
            </button>
            <Link href="/results" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              ← All Runs
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {record && (
          <>
            <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500 font-medium">Description</p>
                  <p className="text-gray-900 mt-1 whitespace-pre-wrap">{record.description}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-gray-500 font-medium">Model</p>
                    <p className="text-gray-900 mt-1">{record.model}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 font-medium">Status</p>
                    <span
                      className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-bold ${
                        STATUS_BADGE[record.status] ?? 'bg-red-100 text-red-800'
                      }`}
                    >
                      {record.status}
                    </span>
                  </div>
                  <div>
                    <p className="text-gray-500 font-medium">Duration</p>
                    <p className="text-gray-900 mt-1">{(record.durationMs / 1000).toFixed(1)}s</p>
                  </div>
                  <div>
                    <p className="text-gray-500 font-medium">Tokens</p>
                    <p className="text-gray-900 mt-1">
                      {record.usage?.totalTokens != null ? record.usage.totalTokens.toLocaleString() : '—'}
                    </p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-4">{new Date(record.createdAt).toLocaleString()}</p>
            </div>

            {record.status === 'running' && (
              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-lg text-sm text-blue-900">
                This run is still in progress; the trace below is its latest checkpoint.{' '}
                <Link href={`/?run=${record.id}`} className="font-semibold underline">
                  Watch it live
                </Link>
              </div>
            )}

            {(record.status === 'interrupted' || record.status === 'failed') && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg text-sm text-amber-900 flex flex-col sm:flex-row sm:items-center gap-3">
                <p className="flex-1">
                  {record.status === 'interrupted'
                    ? `The server stopped while this run was in progress, after ${record.result?.steps.length ?? 0} step(s).`
                    : 'This run failed.'}{' '}
                  Resuming starts a new run with the same request, told what this one already did so it doesn&apos;t repeat completed changes.
                </p>
                <button
                  type="button"
                  disabled={resuming}
                  onClick={handleResume}
                  className="px-4 py-2 bg-amber-600 text-white font-semibold rounded hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {resuming ? 'Starting…' : 'Resume'}
                </button>
              </div>
            )}

            {record.status === 'failed' && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
                <p className="text-red-800 font-medium">Run Error</p>
                <p className="text-red-700 text-sm mt-2 font-mono whitespace-pre-wrap">{record.error}</p>
              </div>
            )}

            {record.result && (
              <AgentTrace
                steps={record.result.steps}
                toolsConsidered={record.result.toolsConsidered}
                finishReason={record.result.finishReason}
                finalText={record.result.finalText}
                usage={record.result.usage}
                stopReason={record.result.stopReason}
              />
            )}

            {record.status === 'completed' && <RunFeedback runId={record.id} />}

            <AuditTrail runId={record.id} />
          </>
        )}
      </div>
    </div>
  );
}
