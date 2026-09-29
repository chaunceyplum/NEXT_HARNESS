'use client';

import { useEffect, useState } from 'react';
import type { AuditRow } from '@/lib/audit-log';

const OUTCOME_STYLE: Record<string, string> = {
  ok: 'bg-green-100 text-green-800',
  approved: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  denied: 'bg-amber-100 text-amber-800',
};

/** Audit events for one run (who started it, every write/destructive call, every approval decision). */
export default function AuditTrail({ runId }: { runId: string }) {
  const [events, setEvents] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/audit?runId=${encodeURIComponent(runId)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setEvents((data.events as AuditRow[]).slice().reverse());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [runId]);

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Audit trail</h2>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {!error && events === null && <p className="text-sm text-gray-500">Loading…</p>}
      {events?.length === 0 && <p className="text-sm text-gray-500">No audited actions for this run.</p>}
      {events && events.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 pr-4 font-medium">Who</th>
                <th className="py-2 pr-4 font-medium">Tool</th>
                <th className="py-2 pr-4 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</td>
                  <td className="py-2 pr-4">{e.type.replace('_', ' ')}</td>
                  <td className="py-2 pr-4">{e.actor}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {e.tool ?? '—'}
                    {e.reason && <span className="block text-gray-400">{e.reason}</span>}
                  </td>
                  <td className="py-2 pr-4">
                    {e.outcome && (
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${OUTCOME_STYLE[e.outcome] ?? 'bg-gray-100 text-gray-800'}`}>
                        {e.outcome}
                      </span>
                    )}
                    {e.error && <span className="block text-xs text-gray-500 mt-1">{e.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
