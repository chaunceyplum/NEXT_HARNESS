'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AgentStepDTO, BuildStreamEvent, ModelOption, TokenUsage, RunVersions } from '@/lib/types';
import AgentTrace from '@/components/AgentTrace';
import KillSwitch from '@/components/KillSwitch';

// ── Streaming state ───────────────────────────────────────────────────────────

interface RunState {
  runId: string;
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

export default function Home() {
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [toolShortlistSize, setToolShortlistSize] = useState(24);
  const [maxSteps, setMaxSteps] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models || []);
        setSelectedModel(data.defaultModel || data.models?.[0]?.key || '');
      })
      .catch((err) => console.error('Failed to load models:', err));
  }, []);

  function handleStop() {
    abortRef.current?.abort();
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

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRunState(null);
    setLoading(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const response = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          model: selectedModel || undefined,
          toolShortlistSize,
          maxSteps,
        }),
        signal: ctrl.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        let msg = `HTTP ${response.status}`;
        try { msg = JSON.parse(text).error ?? msg; } catch { /* plain text error */ }
        throw new Error(msg);
      }

      // Read the NDJSON stream line by line
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: BuildStreamEvent;
        try { event = JSON.parse(trimmed); } catch { return; }

        if (event.type === 'run_start') {
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
        } else if (event.type === 'approval_resolved') {
          setRunState((prev) =>
            prev ? { ...prev, pendingApprovals: prev.pendingApprovals.filter((p) => p.toolCallId !== event.toolCallId) } : prev
          );
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
      // Flush remaining buffer
      if (buffer.trim()) processLine(buffer);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Failed to run agent');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
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
