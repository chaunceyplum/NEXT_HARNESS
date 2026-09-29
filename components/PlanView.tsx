'use client';

import type { PlanInfo } from '@/lib/types';

const STATUS: Record<PlanInfo['steps'][number]['status'], { label: string; cls: string }> = {
  pending: { label: 'pending', cls: 'bg-gray-100 text-gray-700' },
  running: { label: 'running', cls: 'bg-blue-100 text-blue-800' },
  done: { label: 'done', cls: 'bg-green-100 text-green-800' },
  failed: { label: 'failed', cls: 'bg-red-100 text-red-800' },
  skipped: { label: 'skipped', cls: 'bg-gray-100 text-gray-500' },
};

/** The run's plan with live step statuses; Approve/Deny while it awaits a decision. */
export default function PlanView({
  plan,
  awaitingApproval,
  submitting,
  onDecision,
}: {
  plan: PlanInfo;
  awaitingApproval?: boolean;
  submitting?: boolean;
  onDecision?: (approved: boolean) => void;
}) {
  return (
    <div className={`rounded-lg p-4 mb-3 border-l-4 ${awaitingApproval ? 'bg-amber-50 border-amber-500' : 'bg-white border-indigo-400 shadow'}`}>
      <p className="font-semibold text-gray-900">
        {awaitingApproval ? 'Approve this plan before anything runs?' : 'Plan'}
        {plan.version > 1 && <span className="text-xs text-gray-500 font-normal ml-2">revised (v{plan.version})</span>}
      </p>
      <p className="text-sm text-gray-700 mt-1">{plan.goal}</p>
      <ol className="mt-3 space-y-2">
        {plan.steps.map((s) => (
          <li key={s.id} className="flex gap-3 text-sm">
            <span className={`shrink-0 h-fit px-2 py-0.5 rounded text-xs font-semibold ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
            <span className="text-gray-900">
              {s.id}. {s.description}
              {s.tool && <code className="ml-1 text-xs bg-gray-100 px-1 rounded">{s.tool}</code>}
              <span className="block text-xs text-gray-500">expect: {s.expectedOutput}</span>
              {s.note && <span className="block text-xs text-gray-600">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
      {awaitingApproval && onDecision && (
        <div className="flex gap-3 mt-4">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onDecision(true)}
            className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            Approve plan
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onDecision(false)}
            className="px-4 py-2 bg-gray-200 text-gray-800 font-semibold rounded hover:bg-gray-300 disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
