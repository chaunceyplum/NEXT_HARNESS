'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  StatusResponse,
  StepResponse,
  PlanningInfo,
  TraceResponse,
  TraceEventResponse,
  ToolInvocationResponse,
  ApiError,
} from '@/lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  rag: 'RAG',
  aep: 'AEP',
  launch: 'LAUNCH',
  cja: 'CJA',
  ajo: 'AJO',
};

const CATEGORY_COLORS: Record<string, string> = {
  rag: 'bg-purple-100 text-purple-700',
  aep: 'bg-blue-100 text-blue-700',
  launch: 'bg-pink-100 text-pink-700',
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
          <div className="flex items-center gap-4 flex-shrink-0">
            <Link href="/executions" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              ← All Executions
            </Link>
            <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm">
              + New Build
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

            {/* Planning transparency */}
            {status.planning && <PlanningPanel planning={status.planning} />}

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

            {/* Observability: trace timeline, tool invocations, metrics */}
            <ObservabilityPanel executionId={id} executionStatus={status.status} />

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

function PlanningPanel({ planning }: { planning: PlanningInfo }) {
  const included = planning.modules.filter((m) => m.included);
  const skipped = planning.modules.filter((m) => !m.included);

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900">Build Plan (why this order)</h2>
        <span
          className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${
            planning.planning_mode === 'llm' ? 'bg-violet-100 text-violet-800' : 'bg-gray-100 text-gray-700'
          }`}
        >
          {planning.planning_mode === 'llm' ? '✨ LLM-refined' : 'Heuristic'}
        </span>
      </div>

      <p className="text-sm text-gray-600 mb-4">
        <span className="font-semibold">Use case:</span> {planning.use_case.summary}
      </p>

      {planning.llm_reasoning && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 mb-4">
          <p className="text-xs text-violet-500 font-bold uppercase mb-1">LLM Reasoning</p>
          <p className="text-sm text-violet-900">{planning.llm_reasoning}</p>
        </div>
      )}

      {planning.llm_fallback_reason && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
          <p className="text-xs text-gray-500 font-bold uppercase mb-1">Fell back to heuristic</p>
          <p className="text-sm text-gray-700">{planning.llm_fallback_reason}</p>
        </div>
      )}

      <div className="mb-3">
        <p className="text-xs text-gray-500 font-bold uppercase mb-2">
          Module order ({included.length} included)
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {planning.module_order.map((id, i) => {
            const mod = included.find((m) => m.id === id);
            return (
              <div key={id} className="flex items-center gap-2">
                <span className="px-3 py-1 bg-indigo-50 text-indigo-700 rounded-full text-xs font-bold border border-indigo-200">
                  {i + 1}. {mod?.label || id} ({mod?.step_count ?? 0} steps)
                </span>
                {i < planning.module_order.length - 1 && <span className="text-gray-300">→</span>}
              </div>
            );
          })}
        </div>
      </div>

      {skipped.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-gray-500 font-bold uppercase mb-2">Skipped modules</p>
          <ul className="space-y-1">
            {skipped.map((m) => (
              <li key={m.id} className="text-sm text-gray-500">
                <span className="font-medium text-gray-600">{m.label}:</span> {m.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const TRACE_LEVEL_COLORS: Record<string, string> = {
  debug: 'text-gray-400',
  info: 'text-gray-700',
  warn: 'text-yellow-700',
  error: 'text-red-700',
};

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function ObservabilityPanel({
  executionId,
  executionStatus,
}: {
  executionId: string;
  executionStatus: string;
}) {
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<'timeline' | 'invocations'>('timeline');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchTrace() {
    try {
      const res = await fetch(`/api/executions/${executionId}/trace`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TraceResponse = await res.json();
      setTrace(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    fetchTrace();
    const finished =
      executionStatus === 'completed' ||
      executionStatus === 'failed' ||
      executionStatus === 'completed_with_errors';
    if (!finished) {
      pollRef.current = setInterval(fetchTrace, 2500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId, executionStatus]);

  if (loadError) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 rounded-lg">
        <p className="text-yellow-800 text-sm">Could not load observability trace: {loadError}</p>
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-6 text-center text-gray-500 text-sm">
        Loading observability trace...
      </div>
    );
  }

  const m = trace.metrics;

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
      <h2 className="text-xl font-bold text-gray-900 mb-1">Observability</h2>
      <p className="text-sm text-gray-500 mb-4">
        Everything the build did — a structured trace of every lifecycle event and MCP tool call.
      </p>

      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Metric label="Tool calls" value={String(m.total_invocations)} />
        <Metric
          label="Succeeded / Failed"
          value={`${m.invocations_by_status.success ?? 0} / ${m.invocations_by_status.error ?? 0}`}
        />
        <Metric label="Total tool time" value={formatMs(m.total_tool_duration_ms)} />
        <Metric label="Wall clock" value={formatMs(m.wall_clock_ms)} />
      </div>

      {m.slowest_invocation && (
        <p className="text-xs text-gray-500 mb-4">
          Slowest call: <span className="font-mono">{m.slowest_invocation.tool}</span> ({formatMs(m.slowest_invocation.duration_ms)})
          {' · '}avg {formatMs(m.avg_tool_duration_ms)}/call
        </p>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-gray-200">
        <button
          onClick={() => setTab('timeline')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'timeline' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Timeline ({trace.events.length})
        </button>
        <button
          onClick={() => setTab('invocations')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'invocations' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Tool invocations ({trace.invocations.length})
        </button>
      </div>

      {tab === 'timeline' && (
        <div className="max-h-96 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
          {trace.events.length === 0 && (
            <p className="text-sm text-gray-400 p-4">No events recorded yet.</p>
          )}
          {trace.events.map((e: TraceEventResponse) => (
            <div key={e.seq} className="flex items-start gap-3 px-3 py-2 text-sm">
              <span className="text-gray-300 font-mono text-xs w-6 flex-shrink-0 text-right">{e.seq}</span>
              <span className="text-gray-400 font-mono text-xs flex-shrink-0 w-20">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
              <span className={`font-mono text-xs flex-shrink-0 w-44 truncate ${TRACE_LEVEL_COLORS[e.level] || 'text-gray-700'}`}>
                {e.type}
              </span>
              <span className="text-gray-700 flex-1 min-w-0">
                {e.message}
                {e.duration_ms !== undefined && (
                  <span className="text-gray-400 ml-1">({formatMs(e.duration_ms)})</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'invocations' && (
        <div className="max-h-96 overflow-y-auto space-y-2">
          {trace.invocations.length === 0 && (
            <p className="text-sm text-gray-400 p-4">No tool calls recorded yet.</p>
          )}
          {trace.invocations.map((inv: ToolInvocationResponse) => (
            <details key={inv.seq} className="border border-gray-200 rounded-lg p-3">
              <summary className="cursor-pointer flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      inv.status === 'success' ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  ></span>
                  <span className="font-mono text-sm text-gray-900 truncate">{inv.tool}</span>
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0">{formatMs(inv.duration_ms)}</span>
              </summary>
              <div className="mt-3 space-y-2 text-xs">
                <div>
                  <p className="text-gray-400 font-bold uppercase mb-1">Arguments</p>
                  <pre className="bg-gray-50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{inv.args_preview}</pre>
                </div>
                {inv.output_preview !== undefined && (
                  <div>
                    <p className="text-gray-400 font-bold uppercase mb-1">
                      Output {inv.output_bytes !== undefined && `(${inv.output_bytes} bytes)`}
                    </p>
                    <pre className="bg-gray-50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{inv.output_preview}</pre>
                  </div>
                )}
                {inv.error && (
                  <div>
                    <p className="text-red-400 font-bold uppercase mb-1">Error</p>
                    <pre className="bg-red-50 text-red-700 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{inv.error}</pre>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <p className="text-xs text-gray-500 font-medium">{label}</p>
      <p className="text-lg font-bold text-gray-900 mt-0.5">{value}</p>
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
