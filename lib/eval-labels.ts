import type { EvalSuite } from './types';

/** Display names for each eval suite — shared by the /evals list and detail pages. */
export const EVAL_SUITE_LABELS: Record<EvalSuite, string> = {
  agent: 'Agent behavior',
  tool_shortlist: 'Tool shortlisting',
  rag_judge: 'RAG judge calibration',
};

export function passRateClass(passed: number, total: number): string {
  if (total > 0 && passed === total) return 'bg-green-100 text-green-800';
  if (total > 0 && passed / total >= 0.7) return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-800';
}
