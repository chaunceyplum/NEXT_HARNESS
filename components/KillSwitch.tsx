'use client';

import { useEffect, useState } from 'react';
import type { KillSwitchStatus } from '@/lib/kill-switch';

/** Emergency stop for every agent run in this deployment (see lib/kill-switch.ts). */
export default function KillSwitch() {
  const [status, setStatus] = useState<KillSwitchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Status is best-effort; the build route enforces the switch regardless.
    const refresh = () =>
      fetch('/api/admin/kill-switch')
        .then((res) => (res.ok ? res.json() : null))
        .then((data: KillSwitchStatus | null) => data && setStatus(data))
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, []);

  async function toggle(engaged: boolean) {
    let reason = '';
    if (engaged) {
      const answer = window.prompt('Stop every running agent and block new runs? Optional reason:', '');
      if (answer === null) return;
      reason = answer;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engaged, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (status.engaged) {
    return (
      <div className="bg-red-50 border-l-4 border-red-600 p-4 rounded mb-6">
        <p className="text-red-900 font-semibold">Agent disabled — new runs are refused.</p>
        <p className="text-red-800 text-sm mt-1">
          {status.source === 'env'
            ? 'AGENT_DISABLED=true is set for this deployment.'
            : `Kill switch engaged by ${status.by} at ${status.at ? new Date(status.at).toLocaleString() : '?'}${status.reason ? ` — ${status.reason}` : ''}.`}
        </p>
        {status.source === 'runtime' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => toggle(false)}
            className="mt-3 px-3 py-1.5 bg-white border border-red-300 text-red-800 text-sm font-semibold rounded hover:bg-red-100 disabled:opacity-50"
          >
            Re-enable the agent
          </button>
        )}
        {error && <p className="text-red-700 text-xs mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-3 mb-4 text-xs text-gray-600">
      <span>{status.activeRuns.length} active run(s)</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => toggle(true)}
        className="px-3 py-1.5 bg-red-600 text-white font-semibold rounded hover:bg-red-700 disabled:opacity-50"
      >
        Stop all runs
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}
