'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, BuildRequest, BuildResponse, ModelOption } from '@/lib/types';
import AgentTrace from '@/components/AgentTrace';

export default function Home() {
  const [description, setDescription] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [toolShortlistSize, setToolShortlistSize] = useState(24);
  const [maxSteps, setMaxSteps] = useState(20);
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
        toolShortlistSize,
        maxSteps,
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
          <Link
            href="/results"
            className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap"
          >
            View past runs →
          </Link>
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
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="toolShortlistSize" className="block text-sm font-semibold text-gray-700 mb-2">
                Tools considered: {toolShortlistSize}
              </label>
              <input
                id="toolShortlistSize"
                type="range"
                min={4}
                max={80}
                step={1}
                value={toolShortlistSize}
                onChange={(e) => setToolShortlistSize(Number(e.target.value))}
                disabled={loading}
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                How many tools the agent is shown, on top of the always-on set. Raise this if a request needs a
                less obvious tool (e.g. a lookup/list tool) the agent isn&apos;t reaching for — the tradeoff is a
                larger prompt per tool-call turn.
              </p>
            </div>

            <div>
              <label htmlFor="maxSteps" className="block text-sm font-semibold text-gray-700 mb-2">
                Max steps: {maxSteps}
              </label>
              <input
                id="maxSteps"
                type="range"
                min={1}
                max={50}
                step={1}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                disabled={loading}
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tool-call round trips before the agent is forced to stop. Raise this for requests that chain many
                dependent steps (e.g. find a property, then its rules, then add a component) — if a run ends with
                &quot;finished: tool-calls&quot; instead of &quot;stop&quot;, it hit this limit mid-task.
              </p>
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
          <div className="mb-6">
            <p className="text-xs text-gray-500 mb-2">
              Run ID: <code className="bg-white px-2 py-0.5 rounded">{result.runId}</code> ·{' '}
              <Link href={`/results/${result.runId}`} className="text-blue-600 hover:text-blue-700">
                view in history
              </Link>
            </p>
            <AgentTrace
              steps={result.steps}
              toolsConsidered={result.toolsConsidered}
              finishReason={result.finishReason}
              finalText={result.finalText}
              usage={result.usage}
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
