'use client';

import { useState } from 'react';
import { AgentStepDTO } from '@/lib/types';

export interface AgentTraceProps {
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finishReason: string;
  finalText: string;
}

interface SfnHistoryEvent {
  id: number;
  timestamp: string;
  type: string;
  details?: unknown;
}

/** Expandable Step Functions execution history for one tool call — fetched on demand, not persisted. */
function StepFunctionHistory({ executionArn }: { executionArn: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SfnHistoryEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (events || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/step-functions/history?executionArn=${encodeURIComponent(executionArn)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load execution history');
    } finally {
      setLoading(false);
    }
  }

  const shortArn = executionArn.split(':').slice(-2).join(':');

  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        className="text-xs text-indigo-300 hover:text-indigo-200 underline decoration-dotted"
        title={executionArn}
      >
        {open ? '▾' : '▸'} Step Functions: {shortArn}
      </button>
      {open && (
        <div className="mt-1 bg-black/30 rounded p-2 max-h-40 overflow-y-auto">
          {loading && <p className="text-gray-400">Loading history…</p>}
          {error && <p className="text-red-300">{error}</p>}
          {events && events.length === 0 && <p className="text-gray-500">No events.</p>}
          {events?.map((e) => (
            <div key={e.id} className="text-[11px] text-gray-300">
              <span className="text-gray-500">{e.timestamp}</span> {e.type}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Step-by-step tool-call trace for one agent run. Shared between the home page (fresh run) and /results/[id] (replay view). */
export default function AgentTrace({ steps, toolsConsidered, finishReason, finalText }: AgentTraceProps) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Agent Trace</h2>
        <span className="text-xs text-gray-500">
          {toolsConsidered.length} tool(s) considered · finished: {finishReason}
        </span>
      </div>

      <div className="text-xs text-gray-500">
        Tools available this run: {toolsConsidered.join(', ') || 'none'}
      </div>

      <div className="space-y-3">
        {steps.map((step) => (
          <div key={step.stepNumber} className="border border-gray-200 rounded-lg p-4">
            <p className="text-xs font-semibold text-gray-500 mb-2">Step {step.stepNumber + 1}</p>
            {step.text && <p className="text-sm text-gray-800 mb-2 whitespace-pre-wrap">{step.text}</p>}
            {step.toolCalls.map((call, i) => (
              <div key={i} className="bg-gray-900 rounded-lg p-3 mb-2 font-mono text-xs text-green-400 overflow-x-auto">
                <div className="text-blue-300">→ {call.toolName}</div>
                <pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(call.input, null, 2)}</pre>
              </div>
            ))}
            {step.toolResults.map((res, i) => (
              <div
                key={i}
                className={`rounded-lg p-3 font-mono text-xs overflow-x-auto ${
                  res.error ? 'bg-red-950 text-red-300' : 'bg-gray-800 text-gray-300'
                }`}
              >
                <div className={res.error ? 'text-red-300' : 'text-yellow-300'}>
                  ← {res.toolName} {res.error ? 'error' : 'result'}
                </div>
                <pre className="whitespace-pre-wrap break-words mt-1 max-h-48 overflow-y-auto">
                  {res.error ?? JSON.stringify(res.output, null, 2)}
                </pre>
                {res.stepFunctionExecutionArn && <StepFunctionHistory executionArn={res.stepFunctionExecutionArn} />}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-lg">
        <p className="text-green-800 font-medium">Final Answer</p>
        <p className="text-green-900 text-sm mt-1 whitespace-pre-wrap">{finalText}</p>
      </div>
    </div>
  );
}
