/**
 * LLM-as-judge for the MCP server's knowledge-search (RAG) tools.
 *
 * The knowledge base reranks its own results before returning them
 * (server-side, on the MCP) — this judge does not re-rank or second-guess
 * that ordering. Its only job is to score whether the top, already-reranked
 * results are actually good enough to act on: relevant to the query,
 * sufficient to answer it, not stale or off-topic. That's a materially
 * different question than "did reranking put the best result first," and
 * both can be true or false independently of each other.
 *
 * Runs as a side channel next to the real RAG call: a judge failure (bad
 * credentials, model error, malformed structured output) is caught and
 * swallowed here so it can never fail the RAG call it's grading — the
 * caller just gets no judgment attached that time.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel, getDefaultModelKey, getModelEntry, getModelRegistry } from './model-registry';

/**
 * Tools where "judge the retrieval" is a coherent question — a query goes
 * in, ranked results come out. Excludes query_rag_db (raw SELECT against
 * the corpus, not a ranked semantic search) and knowledge_base_health (a
 * stats check, not a retrieval). Keep in sync with RAG_TOOLS in
 * tool-catalog.ts if the live catalog's knowledge-search tools change.
 */
export const JUDGEABLE_RAG_TOOLS = new Set(['search_adobe_knowledge', 'search_all_agents']);

export interface RagJudgment {
  /** 0 (irrelevant) to 5 (squarely on-topic). */
  relevance: number;
  /** Whether the results contain enough to actually answer the query, independent of relevance. */
  sufficient: boolean;
  verdict: 'good' | 'weak' | 'poor';
  rationale: string;
  /** Model registry key the judgment was scored with, so a judgment can be discounted if that model is known-unreliable. */
  judgeModel: string;
}

const ragJudgmentSchema = z.object({
  relevance: z
    .number()
    .min(0)
    .max(5)
    .describe('How relevant the returned results are to the query. 0 = irrelevant, 5 = squarely on-topic.'),
  sufficient: z
    .boolean()
    .describe('Whether the returned results contain enough information to actually answer the query, independent of relevance.'),
  verdict: z
    .enum(['good', 'weak', 'poor'])
    .describe('Overall call on whether this retrieval is good enough to act on as-is.'),
  rationale: z.string().max(300).describe('One or two sentences explaining the verdict — specific to what was returned, not generic.'),
});

/** Same spirit as tool-catalog.ts's arg-summarizing cap — bound prompt size regardless of how much a search tool returns, without losing enough content to actually judge it. */
const MAX_OUTPUT_CHARS_IN_JUDGE_PROMPT = 4000;

function isJudgeEnabled(): boolean {
  return process.env.RAG_JUDGE_ENABLED !== 'false';
}

/** Default share of the agent's own knowledge searches that get judged. */
const DEFAULT_SAMPLE_RATE = 0.1;

/**
 * Whether to judge one knowledge search the agent made during a live run.
 * The judgment is for monitoring retrieval quality — it rides along on the
 * result for the trace, and the agent doesn't act on it — so it doesn't need
 * a second LLM call on every search. Scores a random RAG_JUDGE_SAMPLE_RATE
 * share (0–1, default 0.1; 1 = every search), and never an empty result,
 * which is trivially poor. judgeRagResult itself stays unconditional, so the
 * rag-judge eval is unaffected.
 */
export function shouldJudgeLiveResult(output: unknown, random: () => number = Math.random): boolean {
  if (!isJudgeEnabled() || isEmptyResult(output)) return false;
  const raw = process.env.RAG_JUDGE_SAMPLE_RATE;
  const rate = raw === undefined || raw.trim() === '' ? DEFAULT_SAMPLE_RATE : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  return rate >= 1 || random() < rate;
}

function isEmptyResult(output: unknown): boolean {
  if (output == null || output === '') return true;
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === 'object') {
    const values = Object.values(output as Record<string, unknown>);
    return values.length === 0 || values.every((v) => v == null || v === '' || (Array.isArray(v) && v.length === 0));
  }
  return false;
}

/**
 * Ordered list of model keys to try scoring a judgment with, cheapest first.
 *
 * The judgment is monitoring data the agent never acts on, so it should be
 * scored as cheaply as possible — but not at the cost of reliability. On
 * Bedrock, model access is granted per model, so the cheap tier can be
 * inaccessible even when the default (balanced) works. So rather than
 * hardcoding the cheap tier, we try the *same provider's* cheap tier first
 * and fall back to the harness's default chat model, which is guaranteed to
 * have working credentials (it's what every real run uses). judgeRagResult
 * walks this list in order until one succeeds.
 *
 * RAG_JUDGE_MODEL overrides the whole thing with a single explicit key (no
 * auto-fallback beyond it) — set it when you want to pin the judge to a
 * specific model regardless of the default provider.
 */
function resolveJudgeModelKeys(): string[] {
  const override = process.env.RAG_JUDGE_MODEL;
  if (override) return [override];

  const defaultKey = getDefaultModelKey();
  const keys: string[] = [];

  // Same-provider cheap tier first, if one exists and isn't already the default.
  try {
    const defaultEntry = getModelEntry(defaultKey);
    const cheap = getModelRegistry().find(
      (e) => e.provider === defaultEntry.provider && e.tier === 'cheap'
    );
    if (cheap) keys.push(cheap.key);
  } catch {
    // Unknown/unresolvable default entry — fall through to the default key alone.
  }

  keys.push(defaultKey);
  // De-dupe: the default itself may be the cheap tier, or the cheap lookup
  // may have already produced it.
  return [...new Set(keys)];
}

function summarizeOutputForJudge(output: unknown): string {
  const json = JSON.stringify(output);
  if (json.length <= MAX_OUTPUT_CHARS_IN_JUDGE_PROMPT) return json;
  return `${json.slice(0, MAX_OUTPUT_CHARS_IN_JUDGE_PROMPT)}… (truncated, ${json.length} chars total)`;
}

const JUDGE_SYSTEM_PROMPT = [
  'You grade a single knowledge-base retrieval. You do not answer the query yourself, and you are not asked to.',
  '',
  "The knowledge base already reranks its results before returning them, server-side. Assume the order you're given " +
    "already reflects the system's own best relevance estimate — do not re-rank, reorder, or second-guess the ordering. " +
    'Reranking quality and retrieval quality are different questions; you are only answering the second one.',
  '',
  'Judge whether the results actually returned are good enough to act on: relevant to the query, sufficient to answer ' +
    'it, and not stale or off-topic. Base the rationale on what was actually returned, not on what an ideal result ' +
    'would look like in the abstract.',
].join('\n');

/**
 * Score one RAG lookup's results against its query. Never throws — see
 * module docs for why a judge failure is swallowed rather than propagated.
 */
export async function judgeRagResult(query: string, output: unknown): Promise<RagJudgment | undefined> {
  if (!isJudgeEnabled()) return undefined;

  const candidates = resolveJudgeModelKeys();
  const prompt = `Query: ${query}\n\nRetrieved results (already reranked):\n${summarizeOutputForJudge(output)}`;

  for (const modelKey of candidates) {
    try {
      const { object } = await generateObject({
        model: resolveModel(modelKey),
        schema: ragJudgmentSchema,
        system: JUDGE_SYSTEM_PROMPT,
        prompt,
      });
      return { ...object, judgeModel: modelKey };
    } catch (err) {
      // A cheap-tier model the account can't reach (per-model Bedrock access)
      // shows up here — warn and try the next candidate (the default model,
      // which every real run uses and so is known-good). If they all fail,
      // fall out of the loop and return undefined, same as before.
      console.warn(`[rag-judge] Judgment attempt with model "${modelKey}" failed:`, err instanceof Error ? err.message : err);
    }
  }
  return undefined;
}
