'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, EvalRunDetail, EvalTrialRecord } from '@/lib/types';
import { groupByFixture } from '@/lib/eval-metrics';
import { EVAL_SUITE_LABELS, passRateClass, pct, secs, usd } from '@/lib/eval-labels';

function Tile({ label, value, hint, alert }: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${alert ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-bold ${alert ? 'text-red-700' : 'text-gray-900'}`}>{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function trialStatus(trials: EvalTrialRecord[]): { label: string; className: string } {
  const passed = trials.filter((t) => t.passed).length;
  if (passed === trials.length) return { label: 'PASS', className: 'bg-green-100 text-green-800' };
  if (passed === 0) return { label: 'FAIL', className: 'bg-red-100 text-red-800' };
  return { label: 'FLAKY', className: 'bg-amber-100 text-amber-800' };
}

/** One eval run: run-level metrics, then each fixture's trials with the grader's notes. */
export default function EvalRunPage() {
  const params = useParams();
  const id = params.id as string;

  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/evals/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const errData: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` } as ApiError));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: EvalRunDetail) => setRun(data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load eval run'))
      .finally(() => setLoading(false));
  }, [id]);

  const m = run?.metrics;
  // Failing and flaky fixtures first — they're what a reader is here for.
  const fixtures = run
    ? [...groupByFixture(run.results).entries()].sort(
        ([, a], [, b]) => a.filter((t) => t.passed).length / a.length - b.filter((t) => t.passed).length / b.length
      )
    : [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <Link href="/evals" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
          ← All eval runs
        </Link>

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
        ) : run ? (
          <>
            <div className="bg-white rounded-lg shadow-lg p-6 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">{EVAL_SUITE_LABELS[run.suite] ?? run.suite}</h1>
                  <p className="text-xs text-gray-500 font-mono mt-1">{run.id}</p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-sm font-bold ${passRateClass(
                    run.passedCount,
                    run.totalCount
                  )}`}
                >
                  {run.passedCount}/{run.totalCount} trials
                </span>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div>
                  <dt className="inline text-gray-500">Graded: </dt>
                  <dd className="inline font-mono text-gray-900">{run.subject}</dd>
                </div>
                {run.judgeModel && (
                  <div>
                    <dt className="inline text-gray-500">Judge: </dt>
                    <dd className="inline font-mono text-gray-900">{run.judgeModel}</dd>
                  </div>
                )}
                {run.promptVersion && (
                  <div>
                    <dt className="inline text-gray-500">System prompt: </dt>
                    <dd className="inline font-mono text-gray-900">{run.promptVersion}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline text-gray-500">Started: </dt>
                  <dd className="inline text-gray-900">{new Date(run.startedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Wall time: </dt>
                  <dd className="inline text-gray-900">
                    {((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)}s
                  </dd>
                </div>
              </dl>
            </div>

            {m && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Tile label="Success rate" value={pct(m.successRate)} hint={`n=${m.trials} (${m.fixtures} × k=${m.k})`} />
                <Tile label={`pass@${m.k}`} value={pct(m.passAtK)} hint="any trial passed" />
                <Tile label={`pass^${m.k}`} value={pct(m.passHatK)} hint="every trial passed" />
                <Tile
                  label="Safety violations"
                  value={String(m.safetyViolations)}
                  hint={`${pct(m.safetyViolationRate)} of trials`}
                  alert={m.safetyViolations > 0}
                />
                {m.toolCallAccuracy != null && <Tile label="Tool-call accuracy" value={pct(m.toolCallAccuracy)} />}
                {m.stepsMean != null && <Tile label="Steps (mean)" value={m.stepsMean.toFixed(1)} />}
                <Tile label="Latency p50 / p95" value={`${secs(m.latencyP50Ms)} / ${secs(m.latencyP95Ms)}`} />
                {(m.costPerSuccessUsd != null || m.tokensPerSuccess != null) && (
                  <Tile
                    label="Cost per success"
                    value={usd(m.costPerSuccessUsd)}
                    hint={
                      m.tokensPerSuccess != null
                        ? `${Math.round(m.tokensPerSuccess).toLocaleString()} tokens · list-price estimate`
                        : 'list-price estimate'
                    }
                  />
                )}
              </div>
            )}

            <div className="bg-white rounded-lg shadow-lg divide-y divide-gray-100">
              {fixtures.map(([fixtureId, trials]) => {
                const status = trialStatus(trials);
                const passed = trials.filter((t) => t.passed).length;
                const unsafe = trials.some((t) => t.safetyViolation);
                return (
                  <div key={fixtureId} className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-mono text-sm text-gray-900 break-all">{fixtureId}</p>
                        {trials[0]?.category && <p className="text-xs text-gray-500">{trials[0].category}</p>}
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        {unsafe && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-red-600 text-white">
                            SAFETY
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          {passed}/{trials.length}
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${status.className}`}>
                          {status.label}
                        </span>
                      </div>
                    </div>
                    <ul className="space-y-1">
                      {trials.map((t) => (
                        <li key={t.trial} className="text-xs text-gray-600 flex gap-2">
                          <span className={`shrink-0 font-mono ${t.passed ? 'text-green-700' : 'text-red-700'}`}>
                            #{t.trial} {t.passed ? 'pass' : 'fail'}
                          </span>
                          <span className="shrink-0 text-gray-400">
                            {[
                              secs(t.durationMs),
                              t.steps != null ? `${t.steps} steps` : null,
                              t.totalTokens != null ? `${t.totalTokens.toLocaleString()} tok` : null,
                              t.costUsd != null ? usd(t.costUsd) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {t.notes && <span className="whitespace-pre-wrap break-words">{t.notes}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {run.results.length === 0 && (
                <p className="p-4 text-sm text-gray-500">No fixture results recorded for this run.</p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
