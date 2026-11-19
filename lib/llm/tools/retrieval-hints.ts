/**
 * Agentic RAG, the cheap half (§3.5): grade a knowledge-search result the
 * moment it comes back and, when it's weak, tell the model to retrieve
 * again differently instead of answering from nothing.
 *
 * Deterministic and instant, so it can sit on the tool-call path (the LLM
 * RAG judge in rag-judge.ts runs off the path, for monitoring). "Weak" is:
 *   - no results, or
 *   - results that share almost none of the query's distinctive terms.
 */

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it its of on or should that the this to use what when where which who why with you your we our my'.split(' ')
);

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

function resultItems(output: unknown): unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (output && typeof output === 'object') {
    for (const key of ['results', 'matches', 'documents', 'items', 'chunks']) {
      const v = (output as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return undefined;
}

/** Share of the query's distinctive terms that appear anywhere in the results (0–1). */
export function termOverlap(query: string, output: unknown): number {
  const q = [...new Set(terms(query))];
  if (q.length === 0) return 1;
  const text = JSON.stringify(output ?? '').toLowerCase();
  return q.filter((t) => text.includes(t)).length / q.length;
}

const MIN_OVERLAP = 0.25;

/** A hint for the model when a retrieval looks weak, or undefined when it looks usable. */
export function retrievalHint(toolName: string, query: string | undefined, output: unknown): string | undefined {
  if (!query) return undefined;
  const items = resultItems(output);
  if (items && items.length === 0) {
    return (
      `${toolName} found nothing for this query. Before answering, try once more with a rewritten query: ` +
      'use the specific Adobe product and feature names (e.g. "Real-Time CDP merge policy", "Launch rule condition"), or a synonym. ' +
      'If that also finds nothing, say the knowledge base has no documentation on it; do not answer from memory as if it were documented.'
    );
  }
  if (termOverlap(query, output) < MIN_OVERLAP) {
    return (
      `These ${toolName} results share almost none of the query's key terms, so they are probably off-topic. ` +
      'Rewrite the query with more specific terms and search once more before relying on them; if they are still off-topic, say so rather than answering from them.'
    );
  }
  return undefined;
}

/** Attach the hint (if any) to a result the model will see. */
export function withRetrievalHint(toolName: string, query: string | undefined, output: unknown): unknown {
  const hint = retrievalHint(toolName, query, output);
  if (!hint) return output;
  return output && typeof output === 'object' && !Array.isArray(output)
    ? { _retrievalHint: hint, ...(output as Record<string, unknown>) }
    : { _retrievalHint: hint, results: output };
}
