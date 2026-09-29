'use client';

import { useEffect, useState } from 'react';
import type { RunQuality } from '@/lib/run-quality';

/** 👍/👎 + comment for one run, and the online judge's grade if it was sampled. */
export default function RunFeedback({ runId }: { runId: string }) {
  const [quality, setQuality] = useState<RunQuality | null>(null);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/runs/${encodeURIComponent(runId)}/feedback`)
      .then((res) => (res.ok ? res.json() : null))
      .then((q: RunQuality | null) => {
        if (!q) return;
        setQuality(q);
        if (q.comment) setComment(q.comment);
      })
      .catch(() => {});
  }, [runId]);

  async function rate(rating: 1 | -1) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setQuality(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const btn = (active: boolean) =>
    `px-3 py-1.5 rounded border text-sm font-medium disabled:opacity-50 ${active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-800 border-gray-300 hover:bg-gray-50'}`;

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8 space-y-3">
      <h2 className="text-xl font-bold text-gray-900">Was this run right?</h2>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional: what was wrong, or what was good"
        rows={2}
        className="w-full border border-gray-300 rounded p-2 text-sm"
      />
      <div className="flex items-center gap-2">
        <button type="button" disabled={saving} onClick={() => rate(1)} className={btn(quality?.rating === 1)} aria-pressed={quality?.rating === 1}>
          👍 Good
        </button>
        <button type="button" disabled={saving} onClick={() => rate(-1)} className={btn(quality?.rating === -1)} aria-pressed={quality?.rating === -1}>
          👎 Bad
        </button>
        {quality?.ratedBy && <span className="text-xs text-gray-500">rated by {quality.ratedBy}</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
      {quality?.judgePass !== undefined && (
        <p className="text-sm text-gray-700">
          <span className="font-semibold">Online judge ({quality.judgedBy}):</span> {quality.judgePass ? 'pass' : 'fail'}
          {quality.judgeNotes && <span className="block text-xs text-gray-500 mt-1">{quality.judgeNotes}</span>}
        </p>
      )}
    </div>
  );
}
