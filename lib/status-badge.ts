/**
 * harness_agent_runs.status carries both the old lowercase synchronous-path
 * values ('completed'/'failed') and the new RunLoopStatus uppercase values
 * (lib/types.ts) in the same column — colored generically here rather than
 * as a strict enum. Shared between app/results/page.tsx (list) and
 * app/results/[id]/page.tsx (detail).
 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed':
    case 'COMPLETED':
      return 'bg-green-100 text-green-800';
    case 'failed':
    case 'FAILED':
      return 'bg-red-100 text-red-800';
    case 'REJECTED':
    case 'MAX_STEPS':
      return 'bg-amber-100 text-amber-800';
    case 'AWAITING_APPROVAL':
      return 'bg-purple-100 text-purple-800';
    case 'RUNNING':
    case 'PENDING':
      return 'bg-blue-100 text-blue-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}
