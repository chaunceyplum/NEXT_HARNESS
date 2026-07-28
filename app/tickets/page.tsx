'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ApiError,
  CreateTicketRequest,
  CreateTicketResponse,
  ModelOption,
  TicketPriority,
  TicketsListResponse,
  TicketSummary,
} from '@/lib/types';
import { statusBadgeClass } from '@/lib/status-badge';

const PAGE_SIZE = 20;
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'bg-gray-100 text-gray-700',
  normal: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

export default function TicketsPage() {
  const router = useRouter();

  // Submission form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [requester, setRequester] = useState('');
  const [team, setTeam] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [allowFullBuild, setAllowFullBuild] = useState(false);
  const [autonomous, setAutonomous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // List state
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data: { models: ModelOption[]; defaultModel: string }) => {
        setModels(data.models || []);
        setSelectedModel(data.defaultModel || data.models?.[0]?.key || '');
      })
      .catch((err) => console.error('Failed to load models:', err));
  }, []);

  async function loadTickets(nextOffset: number) {
    setLoading(true);
    try {
      const res = await fetch(`/api/tickets?limit=${PAGE_SIZE}&offset=${nextOffset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TicketsListResponse = await res.json();
      setTickets((prev) => (nextOffset === 0 ? data.tickets : [...prev, ...data.tickets]));
      setTotal(data.total);
      setOffset(nextOffset);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = setTimeout(() => loadTickets(0), 0);
    return () => clearTimeout(initial);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);

    try {
      const payload: CreateTicketRequest = {
        title: title.trim(),
        description: description.trim(),
        priority,
        requester: requester.trim() || undefined,
        team: team.trim() || undefined,
        tags: tagsInput
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        model: selectedModel || undefined,
        allowFullBuild,
        autonomous,
      };

      const response = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: CreateTicketResponse = await response.json();
      router.push(`/tickets/${data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit ticket');
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Tickets</h1>
            <p className="text-gray-600 text-sm mt-1">
              Submit a ticket and its run starts immediately — no separate queue.
            </p>
          </div>
          <Link href="/" className="text-blue-600 hover:text-blue-700 font-medium text-sm whitespace-nowrap">
            ← New Request
          </Link>
        </div>

        {/* Submission form */}
        <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="title" className="block text-sm font-semibold text-gray-700 mb-1">
                Title
              </label>
              <input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary"
                maxLength={200}
                className="w-full p-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
                disabled={submitting}
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-semibold text-gray-700 mb-1">
                What do you want to do?
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the request in detail — this is what the agent acts on"
                className="w-full h-28 p-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none resize-none"
                disabled={submitting}
              />
              <p className="text-xs text-gray-500 mt-1">{description.length} / 5000 characters</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label htmlFor="priority" className="block text-xs font-semibold text-gray-700 mb-1">
                  Priority
                </label>
                <select
                  id="priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                  disabled={submitting}
                  className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="requester" className="block text-xs font-semibold text-gray-700 mb-1">
                  Requester
                </label>
                <input
                  id="requester"
                  value={requester}
                  onChange={(e) => setRequester(e.target.value)}
                  disabled={submitting}
                  className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="team" className="block text-xs font-semibold text-gray-700 mb-1">
                  Team
                </label>
                <input
                  id="team"
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  disabled={submitting}
                  className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="dueAt" className="block text-xs font-semibold text-gray-700 mb-1">
                  Due
                </label>
                <input
                  id="dueAt"
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  disabled={submitting}
                  className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="tags" className="block text-xs font-semibold text-gray-700 mb-1">
                Tags (comma-separated)
              </label>
              <input
                id="tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="cja, segments, urgent-fix"
                disabled={submitting}
                className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="model" className="block text-xs font-semibold text-gray-700 mb-1">
                  Model
                </label>
                <select
                  id="model"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={submitting || models.length === 0}
                  className="w-full p-2 border-2 border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:outline-none"
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-4 pt-5">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={allowFullBuild}
                    onChange={(e) => setAllowFullBuild(e.target.checked)}
                    disabled={submitting}
                    className="w-4 h-4"
                  />
                  Allow full build
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700" title="Skips the human-approval gate for every tool call this ticket's run makes">
                  <input
                    type="checkbox"
                    checked={autonomous}
                    onChange={(e) => setAutonomous(e.target.checked)}
                    disabled={submitting}
                    className="w-4 h-4"
                  />
                  Fully autonomous
                </label>
              </div>
            </div>

            {submitError && (
              <div className="bg-red-50 border-l-4 border-red-500 p-3 rounded">
                <p className="text-red-700 text-sm">{submitError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !title.trim() || description.trim().length < 10}
              className="w-full px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit Ticket'}
            </button>
          </form>
        </div>

        {/* Ticket list */}
        <div>
          <p className="text-gray-600 text-sm mb-2">{total} ticket(s)</p>

          {listError && (
            <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg mb-4">
              <p className="text-red-700 text-sm">{listError}</p>
            </div>
          )}

          {loading && tickets.length === 0 ? (
            <div className="bg-white rounded-lg shadow-lg p-8 text-center">
              <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
              <p className="text-gray-600">Loading...</p>
            </div>
          ) : tickets.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">No tickets yet.</div>
          ) : (
            <div className="bg-white rounded-lg shadow-lg divide-y divide-gray-100">
              {tickets.map((t) => (
                <Link
                  key={t.id}
                  href={`/tickets/${t.id}`}
                  className="flex items-center justify-between gap-4 p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${PRIORITY_BADGE[t.priority]}`}>
                        {t.priority}
                      </span>
                      <p className="text-sm font-medium text-gray-900 truncate">{t.title}</p>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(t.createdAt).toLocaleString()}
                      {t.requester && ` · ${t.requester}`}
                      {t.team && ` · ${t.team}`}
                      {t.autonomous && ' · autonomous'}
                      {t.tags.length > 0 && ` · ${t.tags.join(', ')}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${statusBadgeClass(t.runStatus)}`}
                  >
                    {t.runStatus}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {!loading && tickets.length < total && (
            <div className="text-center mt-4">
              <button
                onClick={() => loadTickets(offset + PAGE_SIZE)}
                className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
