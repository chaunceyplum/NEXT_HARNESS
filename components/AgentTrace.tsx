'use client';

import { AgentStepDTO, TokenUsage } from '@/lib/types';

export interface AgentTraceProps {
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finishReason: string;
  finalText: string;
  /** Chat-model usage for this run. Omit for runs persisted before token tracking was added. */
  usage?: TokenUsage;
  /** Set when a run budget or loop detection cut the run short. */
  stopReason?: string;
}

const STOP_REASON_LABEL: Record<string, string> = {
  'token-budget': 'token budget reached',
  'cost-budget': 'cost ceiling reached',
  'time-budget': 'time limit reached',
  'loop-detected': 'repeated the same tool call',
};

/** Step-by-step tool-call trace for one agent run. Shared between the home page (fresh run) and /results/[id] (replay view). */
export default function AgentTrace({ steps, toolsConsidered, finishReason, finalText, usage, stopReason }: AgentTraceProps) {
  // "stop" means the model decided it was done. "running" means we're still
  // streaming. Anything else (most commonly "tool-calls") means the run was
  // cut off at the step limit, and finalText is not a real conclusion.
  const isRunning = finishReason === 'running';
  const isIncomplete = !isRunning && (finishReason !== 'stop' || Boolean(stopReason));

  const hasUsage = usage && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null);

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Agent Trace</h2>
        <span className={`text-xs flex items-center gap-1.5 ${isIncomplete ? 'text-amber-700 font-semibold' : isRunning ? 'text-blue-600' : 'text-gray-500'}`}>
          {isRunning && (
            <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          )}
          {toolsConsidered.length > 0 ? `${toolsConsidered.length} tool(s) considered · ` : ''}
          {isRunning ? 'running…' : `finished: ${finishReason}`}
        </span>
      </div>

      {hasUsage && (
        <div className="flex items-center gap-6 bg-indigo-50 rounded-lg px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide">Input</p>
            <p className="text-lg font-bold text-indigo-900">{usage!.inputTokens?.toLocaleString() ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide">Output</p>
            <p className="text-lg font-bold text-indigo-900">{usage!.outputTokens?.toLocaleString() ?? '—'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide">Total tokens</p>
            <p className="text-lg font-bold text-indigo-900">{usage!.totalTokens?.toLocaleString() ?? '—'}</p>
          </div>
          <p className="text-xs text-indigo-400 italic ml-auto self-end">
            chat model only — tool-shortlisting and RAG-judge calls not included
          </p>
        </div>
      )}

      <div className="text-xs text-gray-500">Tools available this run: {toolsConsidered.join(', ') || 'none'}</div>

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
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className={`p-4 rounded-lg border-l-4 ${isIncomplete ? 'bg-amber-50 border-amber-500' : isRunning ? 'bg-blue-50 border-blue-400' : 'bg-green-50 border-green-500'}`}>
        <p className={`font-medium ${isIncomplete ? 'text-amber-800' : isRunning ? 'text-blue-700' : 'text-green-800'}`}>
          {isRunning
            ? 'Agent is working…'
            : isIncomplete
              ? `Incomplete — stopped early (${stopReason ? STOP_REASON_LABEL[stopReason] ?? stopReason : finishReason})`
              : 'Final Answer'}
        </p>
        {isIncomplete && stopReason && (
          <p className="text-amber-700 text-xs mt-1">
            A run limit stopped the agent and it was asked to wrap up — the text below summarises partial work.
          </p>
        )}
        {isIncomplete && !stopReason && (
          <p className="text-amber-700 text-xs mt-1">
            {finishReason === 'tool-calls'
              ? 'The agent hit its step limit while still trying to call tools — the text below is not a finished answer. Raise "Max steps" and re-run for a complete result.'
              : 'The run ended before the agent reached a natural stopping point — treat the text below as a fragment, not a conclusion.'}
          </p>
        )}
        {!isRunning && (
          <p className={`text-sm mt-1 whitespace-pre-wrap ${isIncomplete ? 'text-amber-900' : 'text-green-900'}`}>
            {finalText}
          </p>
        )}
      </div>
    </div>
  );
}
