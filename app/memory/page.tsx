'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { MemoryFact } from '@/lib/memory-store';

/** View, add, edit and delete what the agent remembers about this deployment. */
export default function MemoryPage() {
  const [facts, setFacts] = useState<MemoryFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    fetch('/api/memory')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setFacts(data.facts);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [version]);

  async function call(method: 'POST' | 'DELETE', body?: object, query = '') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory${query}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="pt-8">
          <Link href="/" className="text-blue-600 hover:text-blue-700 text-sm font-medium">← Back</Link>
          <h1 className="text-3xl font-bold text-gray-900 mt-2">Deployment memory</h1>
          <p className="text-gray-600 text-sm mt-1">
            Stable facts every run starts with, so the agent doesn&apos;t rediscover them: sandbox names, property ids, repos. The agent adds
            facts it has verified; fix or remove anything wrong here. Never store credentials or personal data (they&apos;re refused).
          </p>
        </div>

        {error && <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded text-red-800 text-sm">{error}</div>}

        <form
          className="bg-white rounded-lg shadow p-4 flex flex-col sm:flex-row gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call('POST', { key, value })) {
              setKey('');
              setValue('');
            }
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key, e.g. aep.prod_sandbox" className="border border-gray-300 rounded p-2 text-sm sm:w-64 font-mono" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" className="border border-gray-300 rounded p-2 text-sm flex-1" />
          <button type="submit" disabled={busy || !key || !value} className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded hover:bg-blue-700 disabled:opacity-50">
            Save
          </button>
        </form>

        <div className="bg-white rounded-lg shadow p-4">
          {facts === null && !error && <p className="text-sm text-gray-500">Loading…</p>}
          {facts?.length === 0 && <p className="text-sm text-gray-500">Nothing remembered yet.</p>}
          {facts && facts.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-3 font-medium">Key</th>
                  <th className="py-2 pr-3 font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">Last set by</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {facts.map((f) => (
                  <tr key={f.key} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 font-mono text-xs">{f.key}</td>
                    <td className="py-2 pr-3">
                      {f.value}
                      {f.note && <span className="block text-xs text-gray-500">{f.note}</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-600">
                      {f.updatedBy}
                      <span className="block text-gray-400">{new Date(f.updatedAt).toLocaleString()}</span>
                      {f.sourceRunId && (
                        <Link href={`/results/${f.sourceRunId}`} className="text-blue-600 hover:text-blue-700">
                          from run
                        </Link>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" disabled={busy} onClick={() => { setKey(f.key); setValue(f.value); }} className="text-blue-600 hover:text-blue-700 text-xs mr-3">
                        Edit
                      </button>
                      <button type="button" disabled={busy} onClick={() => call('DELETE', undefined, `?key=${encodeURIComponent(f.key)}`)} className="text-red-700 hover:text-red-800 text-xs">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
