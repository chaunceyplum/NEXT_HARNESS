'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError, ExecutionRecord, StartRunResponse } from '@/lib/types';
import { statusBadgeClass } from '@/lib/status-badge';
import AgentTrace from '@/components/AgentTrace';

const IN_PROGRESS_STATUSES = new Set(['PENDING', 'RUNNING', 'AWAITING_APPROVAL']);
const POLL_INTERVAL_MS = 3000;

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [record, setRecord] = useState<ExecutionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${id}`);
        if (cancelled) return;

        if (!res.ok) {
          // A fresh Step-Functions run's harness_agent_runs row is created
          // by InitRun, a second or so after StartExecution — treat a 404
          // in the first few polls as "still starting up" rather than an
          // error, since the client only ever gets here right after POST
          // /api/build returned 202.
          if (res.status === 404 && !record) {
            timer = setTimeout(poll, POLL_INTERVAL_MS);
            return;
          }
          const errData: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` } as ApiError));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data: ExecutionRecord = await res.json();
        if (cancelled) return;
        setRecord(data);
        setError(null);
        setLoading(false);

        if (IN_PROGRESS_STATUSES.has(data.status)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load run');
        setLoading(false);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      const data: StartRunResponse = await res.json();
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
                      className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-bold ${statusBadgeClass(record.status)}`}
                    >
                      {record.status}
                      {IN_PROGRESS_STATUSES.has(record.status) && (
                        <span className="inline-block w-1.5 h-1.5 bg-current rounded-full ml-1.5 animate-pulse" />
                      )}
                    </span>
                  </div>
                  <div>
                    <p className="text-gray-500 font-medium">Full build</p>
                    <p className="text-gray-900 mt-1">{record.allowFullBuild ? 'yes' : 'no'}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 font-medium">Duration</p>
                    <p className="text-gray-900 mt-1">{(record.durationMs / 1000).toFixed(1)}s</p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-4">{new Date(record.createdAt).toLocaleString()}</p>
            </div>

            {(record.status === 'failed' || record.status === 'FAILED') && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
                <p className="text-red-800 font-medium">Run Error</p>
                <p className="text-red-700 text-sm mt-2 font-mono whitespace-pre-wrap">{record.error}</p>
              </div>
            )}

            {record.status === 'AWAITING_APPROVAL' && (
              <div className="bg-purple-50 border-l-4 border-purple-500 p-4 rounded-lg">
                <p className="text-purple-800 font-medium">Waiting on human approval</p>
                <p className="text-purple-700 text-sm mt-1">
                  The agent proposed a high-impact tool call and is parked until a reviewer approves or rejects it.{' '}
                  <Link href="/approvals" className="underline font-medium">
                    Review pending approvals →
                  </Link>
                </p>
              </div>
            )}

            {record.status === 'REJECTED' && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg">
                <p className="text-amber-800 font-medium">Rejected</p>
                <p className="text-amber-700 text-sm mt-1">
                  A reviewer rejected a proposed action (or the approval expired) and the run ended here.
                </p>
              </div>
            )}

            {record.status === 'MAX_STEPS' && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg">
                <p className="text-amber-800 font-medium">Stopped — max steps reached</p>
                <p className="text-amber-700 text-sm mt-1">
                  The agent hit its step limit before finishing. Increase maxSteps and replay if it needed more room.
                </p>
              </div>
            )}

            {record.result && (
              <AgentTrace
                steps={record.result.steps}
                toolsConsidered={record.result.toolsConsidered}
                finishReason={record.result.finishReason}
                finalText={record.result.finalText}
              />
            )}

            {record.executionId && (
              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-lg">
                <p className="text-blue-800 font-medium">Triggered a full build</p>
                <p className="text-blue-700 text-sm mt-1">
                  <Link href={`/executions/${record.executionId}`} className="underline">
                    View build progress →
                  </Link>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
