import type { LineageRecord } from '@/lib/types';

const CHANGE_STYLE: Record<LineageRecord['change'], string> = {
  created: 'bg-green-100 text-green-800',
  updated: 'bg-blue-100 text-blue-800',
  deleted: 'bg-red-100 text-red-800',
};

/** The Adobe objects a run created, updated or deleted (RunResult.lineage), in order. */
export default function ObjectChanges({ lineage }: { lineage: LineageRecord[] }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 sm:p-8">
      <h2 className="text-xl font-bold text-gray-900 mb-1">Changed in Adobe</h2>
      <p className="text-sm text-gray-500 mb-4">
        Objects this run changed, from its executed tool calls. Dry-run and denied calls changed nothing and are not listed.
      </p>
      <ul className="divide-y divide-gray-100">
        {lineage.map((entry, i) => (
          <li key={i} className="py-2 flex flex-wrap items-center gap-2 text-sm">
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${CHANGE_STYLE[entry.change]}`}>{entry.change}</span>
            <span className="font-mono text-gray-700">{entry.ref.kind}</span>
            <span className="font-mono text-gray-900 break-all">{entry.ref.id}</span>
            {entry.ref.name && <span className="text-gray-600">“{entry.ref.name}”</span>}
            {entry.ref.sandbox && <span className="text-gray-500">sandbox {entry.ref.sandbox}</span>}
            <span className="text-gray-400 ml-auto">
              {entry.tool} · step {entry.step}
              {entry.workerId ? ` · ${entry.workerId.split(':').slice(1).join(':')}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
