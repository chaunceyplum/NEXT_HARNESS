'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BuildRequest, BuildResponse, ApiError } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const payload: BuildRequest = {
        description: description.trim(),
      };

      const response = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json();
        throw new Error(
          errorData.error || `HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data: BuildResponse = await response.json();

      if (!data.execution_id) {
        throw new Error('No execution_id returned from server');
      }

      // Redirect to execution monitor
      router.push(`/executions/${data.execution_id}`);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to start build';
      setError(errorMessage);
      console.error('Build error:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-12 pt-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="text-center sm:text-left">
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              Autonomous MarTech Builder
            </h1>
            <p className="text-lg sm:text-xl text-gray-600 max-w-lg">
              Describe your MarTech solution in plain English, and we'll build it
              automatically.
            </p>
          </div>
          <Link
            href="/executions"
            className="flex-shrink-0 px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors text-sm shadow-sm"
          >
            View All Executions →
          </Link>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-6">
          <form onSubmit={handleBuild} className="space-y-6">
            <div>
              <label
                htmlFor="description"
                className="block text-lg font-semibold text-gray-700 mb-3"
              >
                What do you want to build?
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Example: Build an AEP solution that tracks ecommerce purchases and identifies high-value customers for email activation..."
                className="w-full h-48 p-4 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none transition-all"
                disabled={loading}
              />
              <p className="text-sm text-gray-500 mt-2">
                {description.length} / 5000 characters
              </p>
            </div>

            {/* Error message */}
            {error && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded">
                <p className="text-red-800 font-medium">Error</p>
                <p className="text-red-700 text-sm mt-1">{error}</p>
              </div>
            )}

            {/* Submit button */}
            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading || !description.trim()}
                className="flex-1 px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Building...
                  </span>
                ) : (
                  'Build'
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Examples */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Example Descriptions
          </h3>
          <ul className="space-y-3 text-sm text-gray-600">
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>
                "Build an AEP solution for our ecommerce store. Track product
                views, add-to-cart, and purchases. Create segments for
                high-value customers and repeat buyers, then activate to email."
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>
                "Set up Adobe Experience Platform for a financial services
                company. We need to track account views, loan applications, and
                document downloads for personalization."
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-blue-500 font-bold">•</span>
              <span>
                "Create a media site solution in AEP with article views, video
                plays, and subscription events. Build segments for engaged
                readers."
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
