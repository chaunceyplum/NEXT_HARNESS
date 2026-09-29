'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AgentStepDTO, BuildStreamEvent, CritiqueInfo, ModelOption, PlanInfo, RouteInfo, RunVersions, TokenUsage } from '@/lib/types';
import AgentTrace from '@/components/AgentTrace';
import PlanView from '@/components/PlanView';
import KillSwitch from '@/components/KillSwitch';

// ── Streaming state ───────────────────────────────────────────────────────────

interface RunState {
  runId: string;
  /** The run's plan, when it planned first. */
  plan?: PlanInfo;
  planAwaitingApproval?: boolean;
  planSubmitting?: boolean;
  critique?: CritiqueInfo;
  /** How an "auto" run picked its model. */
  route?: RouteInfo;
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finalText: string;
  /** TASK 1: assistant text accumulated from text_delta events while the run is live. */
  streamingText: string;
  finishReason: string;
  usage: TokenUsage;
  stopReason?: string;
  budgetUsage?: { tokens: number; costUsd?: number; durationMs: number };
  versions?: RunVersions;
  done: boolean;
  error?: string;
  /** Tool calls the run is paused on, waiting for Approve/Deny. */
  pendingApprovals: PendingApproval[];
}

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Why the call needs a person, e.g. "sends data or code outside the platform". */
  reasonText: string;
  /** Set while the decision POST is in flight. */
  submitting?: boolean;
}

/** Reconnect attempts after a dropped stream before giving up. */
const MAX_RECONNECTS = 3;

export default function Home() {
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [toolShortlistSize, setToolShortlistSize] = useState(24);
  const [maxSteps, setMaxSteps] = useState(20);
  const [planFirst, setPlanFirst] = useState(false);
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);

  // /?run=<id>: attach to a run that's live on the server (e.g. after a reload or a resume).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('run');
    if (!id) return;
    void streamRun((signal) => fetch(`/api/runs/${encodeURIComponent(id)}/events`, { signal }));
  }, []);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models || []);
        setSelectedModel(data.defaultModel || data.models?.[0]?.key || '');
      })
      .catch((err) => console.error('Failed to load models:', err));
  }, []);

  /** Stop the run on the server; its stream then ends with the stop as an error event. */
  async function handleStop() {
    const runId = runIdRef.current;
    const res = runId ? await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => null) : null;
    if (!res?.ok) abortRef.current?.abort();
  }

  async function handleApproval(runId: string, toolCallId: string, approved: boolean) {
    setRunState((prev) =>
      prev
        ? { ...prev, pendingApprovals: prev.pendingApprovals.map((p) => (p.toolCallId === toolCallId ? { ...p, submitting: true } : p)) }
        : prev
    );
    try {
      const res = await fetch('/api/build/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, toolCallId, approved }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      // The card is removed when the stream's approval_resolved event arrives.
    } catch (err) {
      setError(`Could not send decision: ${err instanceof Error ? err.message : String(err)}`);
      setRunState((prev) =>
        prev
          ? { ...prev, pendingApprovals: prev.pendingApprovals.map((p) => (p.toolCallId === toolCallId ? { ...p, submitting: false } : p)) }
          : prev
      );
    }
  }

  /**
   * Stream a run's events into the page. Runs keep going on the server if
   * this connection drops (lib/run-jobs.ts), so a stream that ends without
   * `done` or `error` reconnects to /api/runs/:id/events, which replays the
   * run from its start (the run_start event resets this page's state).
   */
  async function streamRun(open: (signal: AbortSignal) => Promise<Response>) {
    setError(null);
    setRunState(null);
    setLoading(true);
    runIdRef.current = null;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let terminal = false;

    const readEvents = async (response: Response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: BuildStreamEvent;
      try { event = JSON.parse(trimmed); } catch { return; }

      if (event.type === 'done' || event.type === 'error') terminal = true;
      if (event.type === 'run_start') {
        runIdRef.current = event.runId;
        setRunState({
          runId: event.runId,
          steps: [],
          toolsConsidered: event.toolsConsidered,
          finalText: '',
          streamingText: '',
          finishReason: 'running',
          usage: {},
          done: false,
          pendingApprovals: [],
        });
      } else if (event.type === 'step') {
        setRunState((prev) =>
          // A step just finished — its text is now captured in the trace, so
          // reset the live buffer for the next step's streaming text.
          prev ? { ...prev, steps: [...prev.steps, event.step], streamingText: '' } : prev
        );
      } else if (event.type === 'text_delta') {
        setRunState((prev) =>
          prev ? { ...prev, streamingText: prev.streamingText + event.delta } : prev
        );
      } else if (event.type === 'approval_request') {
        setRunState((prev) =>
          prev
            ? {
                ...prev,
                pendingApprovals: [
                  ...prev.pendingApprovals,
                  { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, reasonText: event.reasonText },
                ],
              }
            : prev
        );
      } else if (event.type === 'plan') {
        setRunState((prev) =>
          prev ? { ...prev, plan: event.plan, planAwaitingApproval: Boolean(event.awaitingApproval), planSubmitting: false } : prev
        );
      } else if (event.type === 'approval_resolved') {
        setRunState((prev) =>
          prev
            ? {
                ...prev,
                pendingApprovals: prev.pendingApprovals.filter((p) => p.toolCallId !== event.toolCallId),
                ...(event.toolCallId === 'plan' ? { planAwaitingApproval: false, planSubmitting: false } : {}),
              }
            : prev
        );
      } else if (event.type === 'route') {
        setRunState((prev) => (prev ? { ...prev, route: event.route } : prev));
      } else if (event.type === 'restart') {
        // A fallback model is re-running from scratch — the steps so far
        // and any streamed text belong to the abandoned attempt.
        setRunState((prev) => (prev ? { ...prev, steps: [], streamingText: '' } : prev));
      } else if (event.type === 'done') {
        setRunState((prev) =>
          prev
            ? {
                ...prev,
                toolsConsidered: event.toolsConsidered,
                finalText: event.finalText,
                streamingText: '',
                finishReason: event.finishReason,
                usage: event.usage,
                stopReason: event.stopReason,
                critique: event.critique,
                budgetUsage: event.budgetUsage,
                versions: event.versions,
                done: true,
              }
            : prev
        );
      } else if (event.type === 'error') {
        setError(event.error);
      }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }
      if (buffer.trim()) processLine(buffer);
    };

    try {
      for (let attempt = 0; ; attempt++) {
        const response = await open(ctrl.signal);
        if (!response.ok || !response.body) {
          const text = await response.text();
          let msg = `HTTP ${response.status}`;
          try { msg = JSON.parse(text).error ?? msg; } catch { /* plain text error */ }
          throw new Error(msg);
        }
        try {
          await readEvents(response);
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          // A dropped connection: fall through and reconnect.
        }
        const runId = runIdRef.current;
        if (terminal || ctrl.signal.aborted || !runId || attempt >= MAX_RECONNECTS) {
          if (!terminal && !ctrl.signal.aborted) setError('Lost the connection to this run. It may still be running: reload to check.');
          break;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        open = (signal) => fetch(`/api/runs/${encodeURIComponent(runId)}/events`, { signal });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Failed to run agent');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    await streamRun((signal) =>
      fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          model: selectedModel || undefined,
          toolShortlistSize,
          maxSteps,
          ...(planFirst ? { planFirst: true, requirePlanApproval } : {}),
        }),
        signal,
      })
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto">
        <KillSwitch />
        {/* Header */}
        <div className="mb-12 pt-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div className="text-center sm:text-left">
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              Autonomous MarTech Builder
            </h1>
            <p className="text-lg sm:text-xl text-gray-600 max-w-lg">
              Describe what you want, and an agent will pick the right tools to do it —
              no fixed pipeline, no full rebuild for a narrow ask.
            </p>
          </div>
          <div className="flex flex-col items-center sm:items-end gap-1">
            <Link href="/results" className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap">
              View past runs →
            </Link>
            <Link href="/memory" className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap">
              Deployment memory →
            </Link>
            <Link href="/metrics" className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap">
              Production metrics →
            </Link>
            <Link href="/evals" className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap">
              View evals →
            </Link>
          </div>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-6">
          <form onSubmit={handleBuild} className="space-y-6">
            <div>
              <label htmlFor="description" className="block text-lg font-semibold text-gray-700 mb-3">
                What do you want to do?
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Example: Create a new XDM schema for ecommerce purchase events..."
                className="w-full h-40 p-4 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none transition-all"
                disabled={loading}
              />
              <p className="text-sm text-gray-500 mt-2">{description.length} / 5000 characters</p>
            </div>

            <div>
              <label htmlFor="model" className="block text-sm font-semibold text-gray-700 mb-2">
                Model
              </label>
              <select
                id="model"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={loading || models.length === 0}
                className="w-full p-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
              >
                {models.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="toolShortlistSize" className="block text-sm font-semibold text-gray-700 mb-2">
                Tools considered: {toolShortlistSize}
              </label>
              <input
                id="toolShortlistSize"
                type="range" min={4} max={80} step={1}
                value={toolShortlistSize}
                onChange={(e) => setToolShortlistSize(Number(e.target.value))}
                disabled={loading}
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                How many tools the agent is shown, on top of the always-on set. Raise this if a request needs a
                less obvious tool the agent isn&apos;t reaching for.
              </p>
            </div>

            <div>
              <label htmlFor="maxSteps" className="block text-sm font-semibold text-gray-700 mb-2">
                Max steps: {maxSteps}
              </label>
              <input
                id="maxSteps"
                type="range" min={1} max={50} step={1}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                disabled={loading}
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tool-call round trips before the agent is forced to stop. If a run ends with
                &quot;finished: tool-calls&quot; instead of &quot;stop&quot;, raise this.
              </p>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} disabled={loading} />
                <span className="font-semibold">Plan first</span>
                <span className="text-xs text-gray-500">— break multi-step work into a plan and track each step</span>
              </label>
              {planFirst && (
                <label className="flex items-center gap-2 text-sm text-gray-700 ml-6">
                  <input
                    type="checkbox"
                    checked={requirePlanApproval}
                    onChange={(e) => setRequirePlanApproval(e.target.checked)}
                    disabled={loading}
                  />
                  Ask me to approve the plan before anything runs
                </label>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded">
                <p className="text-red-800 font-medium">Error</p>
                <p className="text-red-700 text-sm mt-1">{error}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading || !description.trim()}
                className="flex-1 px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Running…
                  </span>
                ) : (
                  'Run'
                )}
              </button>
              {loading && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="px-6 py-3 bg-gray-200 text-gray-700 font-bold rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Stop
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Live agent trace — updates as steps stream in */}
        {runState && (
          <div className="mb-6">
            <p className="text-xs text-gray-500 mb-2">
              Run ID: <code className="bg-white px-2 py-0.5 rounded">{runState.runId}</code>
              {runState.done && (
                <>
                  {' · '}
                  <Link href={`/results/${runState.runId}`} className="text-blue-600 hover:text-blue-700">
                    view in history
                  </Link>
                </>
              )}
              {loading && (
                <span className="ml-2 inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin align-middle" />
              )}
            </p>
            {runState.plan && (
              <PlanView
                plan={runState.plan}
                awaitingApproval={runState.planAwaitingApproval}
                submitting={runState.planSubmitting}
                onDecision={(approved) => {
                  setRunState((prev) => (prev ? { ...prev, planSubmitting: true } : prev));
                  handleApproval(runState.runId, 'plan', approved);
                }}
              />
            )}
            {runState.route && (
              <p className="text-xs text-gray-600 mb-3">
                Auto-routed to <code className="bg-white px-1 rounded">{runState.route.modelKey}</code> as a{' '}
                <strong>{runState.route.category}</strong> request ({runState.route.via}, confidence{' '}
                {Math.round(runState.route.confidence * 100)}%): {runState.route.reason}
              </p>
            )}
            {runState.pendingApprovals.map((p) => (
              <div key={p.toolCallId} className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded mb-3">
                <p className="text-amber-900 font-semibold">Approval needed: {p.reasonText}</p>
                <p className="text-amber-800 text-sm mt-1">
                  The agent wants to run <code className="bg-white px-1.5 py-0.5 rounded">{p.toolName}</code> with:
                </p>
                <pre className="bg-white text-xs text-gray-800 p-3 rounded mt-2 overflow-x-auto max-h-60">
                  {JSON.stringify(p.input, null, 2)}
                </pre>
                <div className="flex gap-3 mt-3">
                  <button
                    type="button"
                    disabled={p.submitting}
                    onClick={() => handleApproval(runState.runId, p.toolCallId, true)}
                    className="px-4 py-2 bg-red-600 text-white font-semibold rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={p.submitting}
                    onClick={() => handleApproval(runState.runId, p.toolCallId, false)}
                    className="px-4 py-2 bg-gray-200 text-gray-800 font-semibold rounded hover:bg-gray-300 disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
            <AgentTrace
              steps={runState.steps}
              toolsConsidered={runState.toolsConsidered}
              finishReason={runState.done ? runState.finishReason : 'running'}
              // TASK 1: show the answer as it streams; the 'done' event
              // replaces it with the authoritative final text.
              finalText={runState.done ? runState.finalText : runState.streamingText}
              usage={runState.done ? runState.usage : undefined}
              stopReason={runState.done ? runState.stopReason : undefined}
              budgetUsage={runState.done ? runState.budgetUsage : undefined}
              versions={runState.done ? runState.versions : undefined}
              critique={runState.done ? runState.critique : undefined}
            />
          </div>
        )}

        {/* Examples */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Example Requests</h3>
          <ul className="space-y-3 text-sm text-gray-600">
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>&quot;Create a new XDM schema for tracking ecommerce purchase events.&quot; (narrow — one tool)</span>
            </li>
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>&quot;What&apos;s the best-practice merge policy for a media site with cross-device identity?&quot; (knowledge lookup)</span>
            </li>
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>&quot;Create an XDM schema, a segment, and a CJA data view for our new loyalty program.&quot; (chains several tool calls)</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
