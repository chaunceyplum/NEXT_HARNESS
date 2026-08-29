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
import { resolveModel, getDefaultModelKey } from './model-registry';

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

/** Defaults to the harness's own default chat model (guaranteed to have working credentials) rather than a hardcoded cheap tier — override with RAG_JUDGE_MODEL to spend less per lookup. */
function judgeModelKey(): string {
  return process.env.RAG_JUDGE_MODEL || getDefaultModelKey();
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

  const modelKey = judgeModelKey();
  try {
    const { object } = await generateObject({
      model: resolveModel(modelKey),
      schema: ragJudgmentSchema,
      system: JUDGE_SYSTEM_PROMPT,
      prompt: `Query: ${query}\n\nRetrieved results (already reranked):\n${summarizeOutputForJudge(output)}`,
    });
    return { ...object, judgeModel: modelKey };
  } catch (err) {
    console.warn(`[rag-judge] Skipping judgment (model "${modelKey}"):`, err instanceof Error ? err.message : err);
    return undefined;
  }
}
