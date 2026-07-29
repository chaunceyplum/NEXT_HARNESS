'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, TicketDetailResponse, TicketPriority } from '@/lib/types';
import { statusBadgeClass } from '@/lib/status-badge';
import AgentTrace from '@/components/AgentTrace';

const IN_PROGRESS_STATUSES = new Set(['PENDING', 'RUNNING', 'AWAITING_APPROVAL']);
const POLL_INTERVAL_MS = 3000;

const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'bg-gray-100 text-gray-700',
  normal: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

export default function TicketDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<TicketDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch(`/api/tickets/${id}`);
        if (cancelled) return;

        if (!res.ok) {
          const errData: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` } as ApiError));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const body: TicketDetailResponse = await res.json();
        if (cancelled) return;
        setData(body);
        setError(null);
        setLoading(false);

        if (IN_PROGRESS_STATUSES.has(body.ticket.runStatus)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load ticket');
        setLoading(false);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading ticket...</p>
          </div>
        </div>
      </div>
    );
  }

  const ticket = data?.ticket;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">{ticket?.title ?? 'Ticket'}</h1>
            <p className="text-gray-600 text-sm mt-1">
              <code className="bg-white px-2 py-0.5 rounded">{id}</code>
            </p>
          </div>
          <Link href="/tickets" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
            ← All Tickets
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
            <p className="text-red-800 font-medium">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {ticket && (
          <>
            <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${PRIORITY_BADGE[ticket.priority]}`}>
                  {ticket.priority}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${statusBadgeClass(ticket.runStatus)}`}>
                  {ticket.runStatus}
                  {IN_PROGRESS_STATUSES.has(ticket.runStatus) && (
                    <span className="inline-block w-1.5 h-1.5 bg-current rounded-full ml-1.5 animate-pulse" />
                  )}
                </span>
                {ticket.autonomous && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-purple-100 text-purple-700">
                    autonomous
                  </span>
                )}
                {ticket.allowFullBuild && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-indigo-100 text-indigo-700">
                    full build
                  </span>
                )}
                {ticket.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500 font-medium">Description</p>
                  <p className="text-gray-900 mt-1 whitespace-pre-wrap">{ticket.description}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {ticket.requester && (
                    <div>
                      <p className="text-gray-500 font-medium">Requester</p>
                      <p className="text-gray-900 mt-1">{ticket.requester}</p>
                    </div>
                  )}
                  {ticket.team && (
                    <div>
                      <p className="text-gray-500 font-medium">Team</p>
                      <p className="text-gray-900 mt-1">{ticket.team}</p>
                    </div>
                  )}
                  {ticket.dueAt && (
                    <div>
                      <p className="text-gray-500 font-medium">Due</p>
                      <p className="text-gray-900 mt-1">{new Date(ticket.dueAt).toLocaleDateString()}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-gray-500 font-medium">Model</p>
                    <p className="text-gray-900 mt-1">{ticket.model}</p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-4">
                Created {new Date(ticket.createdAt).toLocaleString()} ·{' '}
                <Link href={`/results/${ticket.runId}`} className="underline">
                  view run {ticket.runId}
                </Link>
              </p>
            </div>

            {(ticket.runStatus === 'failed' || ticket.runStatus === 'FAILED') && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
                <p className="text-red-800 font-medium">Run Error</p>
                <p className="text-red-700 text-sm mt-2 font-mono whitespace-pre-wrap">{data?.error}</p>
              </div>
            )}

            {ticket.runStatus === 'AWAITING_APPROVAL' && (
              <div className="bg-purple-50 border-l-4 border-purple-500 p-4 rounded-lg">
                <p className="text-purple-800 font-medium">Waiting on human approval</p>
                <p className="text-purple-700 text-sm mt-1">
                  <Link href="/approvals" className="underline font-medium">
                    Review pending approvals →
                  </Link>
                </p>
              </div>
            )}

            {ticket.runStatus === 'REJECTED' && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg">
                <p className="text-amber-800 font-medium">Rejected</p>
                <p className="text-amber-700 text-sm mt-1">A reviewer rejected a proposed action and the run ended here.</p>
              </div>
            )}

            {ticket.runStatus === 'MAX_STEPS' && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg">
                <p className="text-amber-800 font-medium">Stopped — max steps reached</p>
              </div>
            )}

            {data?.result && (
              <AgentTrace
                steps={data.result.steps}
                toolsConsidered={data.result.toolsConsidered}
                finishReason={data.result.finishReason}
                finalText={data.result.finalText}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
