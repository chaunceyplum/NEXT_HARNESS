'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductionMetrics } from '@/lib/production-metrics';

const pct = (x: number | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const secs = (ms: number | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const usd = (x: number | undefined) => (x == null ? '—' : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);
const WINDOWS = [1, 7, 30, 90];

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {detail && <p className="text-xs text-gray-500 mt-1">{detail}</p>}
    </div>
  );
}

/** Production agent metrics: the online half of the eval stack (lib/production-metrics.ts). */
export default function MetricsPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<(ProductionMetrics & { days: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/metrics?days=${days}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setError(null);
        setData(body);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [days]);

  const m = data?.days === days ? data : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 pt-8">
          <div>
            <Link href="/" className="text-blue-600 hover:text-blue-700 text-sm font-medium">← Back</Link>
            <h1 className="text-3xl font-bold text-gray-900 mt-2">Production metrics</h1>
            <p className="text-gray-600 text-sm mt-1">
              Real runs, not eval fixtures. A run succeeds when it completed on its own, wasn&apos;t cut off by a limit, and nobody graded it bad (judge fail or 👎).
            </p>
          </div>
          <div className="flex gap-1" role="group" aria-label="Time window">
            {WINDOWS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={d === days}
                className={`px-3 py-1.5 text-sm rounded font-medium ${d === days ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
              >
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded text-red-800 text-sm">{error}</div>}
        {!error && !m && <p className="text-gray-500 text-sm">Loading…</p>}

        {m && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Tile label="Success rate" value={pct(m.successRate)} detail={`${m.successes} of ${m.runs} runs`} />
              <Tile label="Latency" value={secs(m.latencyP95Ms)} detail={`p95 · p50 ${secs(m.latencyP50Ms)}`} />
              <Tile label="Cost per success" value={usd(m.costPerSuccessUsd)} detail={m.totalCostUsd == null ? 'some runs unpriced' : `${usd(m.totalCostUsd)} total`} />
              <Tile label="Escalation rate" value={pct(m.escalationRate)} detail="runs with a denied tool call" />
              <Tile label="Steps" value={m.stepsMean == null ? '—' : m.stepsMean.toFixed(1)} detail="mean per completed run" />
              <Tile label="Judge pass rate" value={pct(m.judgePassRate)} detail={`${m.judged} run(s) sampled`} />
              <Tile label="Feedback" value={`👍 ${m.thumbsUp} · 👎 ${m.thumbsDown}`} detail={`${m.rated} run(s) rated`} />
              <Tile label="Completed" value={pct(m.runs ? m.completed / m.runs : undefined)} detail={`${m.runs - m.completed} failed`} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-3">How runs ended</h2>
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(m.stopReasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, n]) => (
                        <tr key={reason} className="border-b last:border-0">
                          <td className="py-2 text-gray-800">{reason}</td>
                          <td className="py-2 text-right text-gray-900 font-medium tabular-nums">{n}</td>
                          <td className="py-2 text-right text-gray-500 tabular-nums w-16">{pct(n / m.runs)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-3">By model</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-2 font-medium">Model</th>
                      <th className="py-2 font-medium text-right">Runs</th>
                      <th className="py-2 font-medium text-right">Success</th>
                      <th className="py-2 font-medium text-right">p95</th>
                      <th className="py-2 font-medium text-right">$/success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.byModel.map((row) => (
                      <tr key={row.model} className="border-b last:border-0">
                        <td className="py-2 font-mono text-xs text-gray-800">{row.model}</td>
                        <td className="py-2 text-right tabular-nums">{row.runs}</td>
                        <td className="py-2 text-right tabular-nums">{pct(row.successRate)}</td>
                        <td className="py-2 text-right tabular-nums">{secs(row.latencyP95Ms)}</td>
                        <td className="py-2 text-right tabular-nums">{usd(row.costPerSuccessUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold text-gray-900">Review queue</h2>
              <p className="text-sm text-gray-500 mb-3">
                Runs rated 👎 or failed by the judge. Review a few each week, and turn each real failure into an eval case (see OPERATIONS.md).
              </p>
              {m.needsReview.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing to review in this window.</p>
              ) : (
                <ul className="divide-y">
                  {m.needsReview.map((r) => (
                    <li key={r.id} className="py-2 text-sm">
                      <Link href={`/results/${r.id}`} className="text-blue-600 hover:text-blue-700 font-medium">
                        {r.description.slice(0, 100)}
                      </Link>
                      <span className="text-gray-500 ml-2">
                        {new Date(r.createdAt).toLocaleString()}
                        {r.rating === -1 && ' · 👎'}
                        {r.judgePass === false && ' · judge: fail'}
                      </span>
                      {r.comment && <p className="text-gray-600 text-xs mt-0.5">“{r.comment}”</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
