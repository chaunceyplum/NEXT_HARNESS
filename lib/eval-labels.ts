import type { EvalSuite } from './types';

/** Display names for each eval suite — shared by the /evals list and detail pages. */
export const EVAL_SUITE_LABELS: Record<EvalSuite, string> = {
  agent: 'Agent behavior',
  tool_shortlist: 'Tool shortlisting',
  rag_judge: 'RAG judge calibration',
  judge_calibration: 'Eval judge calibration',
};

export function passRateClass(passed: number, total: number): string {
  if (total > 0 && passed === total) return 'bg-green-100 text-green-800';
  if (total > 0 && passed / total >= 0.7) return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-800';
}

export const pct = (x: number | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const secs = (ms: number | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
export const usd = (x: number | undefined) => (x == null ? '—' : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`);
