'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, ApprovalSummary } from '@/lib/types';

const POLL_INTERVAL_MS = 5000;

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [feedbackByApproval, setFeedbackByApproval] = useState<Record<string, string>>({});

  async function load() {
    try {
      const res = await fetch('/api/approvals');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { approvals: ApprovalSummary[] } = await res.json();
      setApprovals(data.approvals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Deferred so the fetch (and its setState calls) run outside the
    // synchronous effect body rather than during React's commit phase.
    const initial = setTimeout(load, 0);
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  async function resolve(id: string, decision: 'approve' | 'reject') {
    setPendingAction(id);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, feedback: feedbackByApproval[id] }),
      });
      if (!res.ok) {
        const errData: ApiError = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${decision} run`);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Pending Approvals</h1>
            <p className="text-gray-600 text-sm mt-1">{approvals.length} waiting on review</p>
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

        {loading ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        ) : approvals.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
            Nothing waiting on review right now.
          </div>
        ) : (
          <div className="space-y-4">
            {approvals.map((a) => (
              <div key={a.id} className="bg-white rounded-lg shadow-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <Link href={`/results/${a.runId}`} className="text-xs text-blue-600 hover:text-blue-700">
                    run {a.runId} →
                  </Link>
                  <span className="text-xs text-gray-400">{new Date(a.createdAt).toLocaleString()}</span>
                </div>

                {a.reasoning && (
                  <div>
                    <p className="text-sm font-semibold text-gray-700 mb-1">Agent&apos;s reasoning</p>
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.reasoning}</p>
                  </div>
                )}

                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-2">Proposed call(s)</p>
                  <div className="space-y-2">
                    {a.gatedCalls.map((call, i) => (
                      <div
                        key={i}
                        className="bg-gray-900 rounded-lg p-3 font-mono text-xs text-green-400 overflow-x-auto"
                      >
                        <div className="text-blue-300">→ {call.toolName}</div>
                        <pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(call.input, null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                </div>

                <textarea
                  value={feedbackByApproval[a.id] ?? ''}
                  onChange={(e) => setFeedbackByApproval((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  placeholder="Tell the agent what to change — this goes straight into its context."
                  className="w-full h-20 p-3 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none resize-none"
                  disabled={pendingAction === a.id}
                />

                <div className="flex gap-3">
                  <button
                    onClick={() => resolve(a.id, 'approve')}
                    disabled={pendingAction === a.id}
                    className="flex-1 px-4 py-2 bg-green-600 text-white text-sm font-bold rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {pendingAction === a.id ? 'Working...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => resolve(a.id, 'reject')}
                    disabled={pendingAction === a.id}
                    className="flex-1 px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {pendingAction === a.id ? 'Working...' : 'Reject'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
