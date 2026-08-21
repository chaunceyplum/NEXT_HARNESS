'use client';

import { AgentStepDTO } from '@/lib/types';

export interface AgentTraceProps {
  steps: AgentStepDTO[];
  toolsConsidered: string[];
  finishReason: string;
  finalText: string;
}

/** Step-by-step tool-call trace for one agent run. Shared between the home page (fresh run) and /results/[id] (replay view). */
export default function AgentTrace({ steps, toolsConsidered, finishReason, finalText }: AgentTraceProps) {
  // "stop" means the model decided it was done. Anything else — most
  // commonly "tool-calls", meaning it hit maxSteps while still trying to
  // call tools — means the run was cut off mid-task, and finalText is
  // whatever sentence it was in the middle of, not a real conclusion.
  const isIncomplete = finishReason !== 'stop';

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Agent Trace</h2>
        <span className={`text-xs ${isIncomplete ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}>
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
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className={`p-4 rounded-lg border-l-4 ${isIncomplete ? 'bg-amber-50 border-amber-500' : 'bg-green-50 border-green-500'}`}>
        <p className={`font-medium ${isIncomplete ? 'text-amber-800' : 'text-green-800'}`}>
          {isIncomplete ? `Incomplete — stopped early (${finishReason})` : 'Final Answer'}
        </p>
        {isIncomplete && (
          <p className="text-amber-700 text-xs mt-1">
            {finishReason === 'tool-calls'
              ? 'The agent hit its step limit while still trying to call tools — the text below is not a finished answer. Raise "Max steps" and re-run for a complete result.'
              : 'The run ended before the agent reached a natural stopping point — treat the text below as a fragment, not a conclusion.'}
          </p>
        )}
        <p className={`text-sm mt-1 whitespace-pre-wrap ${isIncomplete ? 'text-amber-900' : 'text-green-900'}`}>
          {finalText}
        </p>
      </div>
    </div>
  );
}
