'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, BuildRequest, BuildResponse, ModelOption } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [allowFullBuild, setAllowFullBuild] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResponse | null>(null);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models || []);
        setSelectedModel(data.defaultModel || data.models?.[0]?.key || '');
      })
      .catch((err) => console.error('Failed to load models:', err));
  }, []);

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const payload: BuildRequest = {
        description: description.trim(),
        model: selectedModel || undefined,
        allowFullBuild,
      };

      const response = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data: BuildResponse = await response.json();

      if (data.executionId) {
        // A full end-to-end build was triggered — switch to the async status view.
        router.push(`/executions/${data.executionId}`);
        return;
      }

      setResult(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to run agent';
      setError(errorMessage);
      console.error('Build error:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-12 pt-8 text-center sm:text-left">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
            Autonomous MarTech Builder
          </h1>
          <p className="text-lg sm:text-xl text-gray-600 max-w-lg">
            Describe what you want, and an agent will pick the right tools to do it —
            no fixed pipeline, no full rebuild for a narrow ask.
          </p>
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-gray-700 p-3">
                  <input
                    type="checkbox"
                    checked={allowFullBuild}
                    onChange={(e) => setAllowFullBuild(e.target.checked)}
                    disabled={loading}
                    className="w-4 h-4"
                  />
                  <span>
                    Allow full end-to-end build
                    <span className="block text-xs text-gray-500">
                      Creates real resources across Adobe/AWS/GitHub/Netlify — leave off for narrow requests
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded">
                <p className="text-red-800 font-medium">Error</p>
                <p className="text-red-700 text-sm mt-1">{error}</p>
              </div>
            )}

            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading || !description.trim()}
                className="flex-1 px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Running agent...
                  </span>
                ) : (
                  'Run'
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Agent trace */}
        {result && (
          <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8 mb-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-900">Agent Trace</h2>
              <span className="text-xs text-gray-500">
                {result.toolsConsidered.length} tool(s) considered · finished: {result.finishReason}
              </span>
            </div>

            <div className="text-xs text-gray-500">
              Tools available this run: {result.toolsConsidered.join(', ') || 'none'}
            </div>

            <div className="space-y-3">
              {result.steps.map((step) => (
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
                    <div key={i} className="bg-gray-800 rounded-lg p-3 font-mono text-xs text-gray-300 overflow-x-auto">
                      <div className="text-yellow-300">← {res.toolName} result</div>
                      <pre className="whitespace-pre-wrap break-words mt-1 max-h-48 overflow-y-auto">
                        {JSON.stringify(res.output, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-lg">
              <p className="text-green-800 font-medium">Final Answer</p>
              <p className="text-green-900 text-sm mt-1 whitespace-pre-wrap">{result.finalText}</p>
            </div>
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
              <span>
                &quot;Build our entire ecommerce AEP solution end-to-end: schema, segments, CJA, and email
                activation.&quot; (needs &quot;Allow full end-to-end build&quot; enabled)
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
