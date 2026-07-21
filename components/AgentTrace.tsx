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
