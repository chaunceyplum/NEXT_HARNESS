/**
 * search_knowledge: a knowledge-base search the model may call itself, a
 * few times per run.
 *
 * Retrieval used to happen in exactly two places — once at planning, with
 * the raw request as the query, and on tool errors — and the model had no
 * search tool at all. That was a deliberate fix: when the model could search
 * freely, troubleshooting loops made ~9 searches whose 8-16K-char results
 * each stayed in context, and one run burned ~400K input tokens. But it left
 * every question the one up-front search missed (or that it dropped as weak)
 * with nothing to ground on, and the prompt told the model not to answer from
 * memory, so it hedged or refused.
 *
 * This restores search with the old failure mode fenced off:
 *
 *   - a per-run limit (KNOWLEDGE_SEARCHES_PER_RUN, default 4; 0 turns the
 *     tool off and restores the planning-only behaviour);
 *   - results go through the same wrapper the MCP tool always used, so they
 *     stay capped (capRagResult, 4,000 chars), carry the weak-retrieval
 *     rewrite hint and are sampled by the RAG judge;
 *   - a repeated query returns the stored result again (the earlier copy
 *     may have been compressed out of context) and doesn't use up the limit.
 */

import { jsonSchema, tool, type Tool } from 'ai';

/** The MCP knowledge tool this searches through. */
export const KNOWLEDGE_SOURCE_TOOL = 'search_adobe_knowledge';
export const KNOWLEDGE_SEARCH_TOOL = 'search_knowledge';

const DEFAULT_SEARCHES_PER_RUN = 4;
const MAX_SEARCHES_PER_RUN = 20;

/** KNOWLEDGE_SEARCHES_PER_RUN: searches the model may make per run (default 4, 0 = no search tool, max 20). */
export function knowledgeSearchesPerRun(): number {
  const raw = process.env.KNOWLEDGE_SEARCHES_PER_RUN?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SEARCHES_PER_RUN;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_SEARCHES_PER_RUN) : DEFAULT_SEARCHES_PER_RUN;
}

function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build search_knowledge over `source` — the run's already-wrapped
 * search_adobe_knowledge tool (policy, guardrails, capping, RAG judge).
 * One per run: the limit and the query memo are per instance.
 */
export function knowledgeSearchTool(source: Tool, limit: number): Tool {
  let used = 0;
  const seen = new Map<string, { n: number; result: unknown }>();

  return tool({
    description:
      'Search the Adobe solutions-architecture knowledge base (AEP, CJA, Launch/Reactor, AJO documentation and internal guidance). ' +
      `Use it for documented behaviour, constraints, required fields or how-to steps that the excerpts given with the request do not cover. ` +
      `At most ${limit} searches this run, so write one specific query per question (product + object + what you need to know).`,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A specific question or phrase, e.g. "XDM ExperienceEvent required fields for a web schema".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query }, options) => {
      const key = normaliseQuery(query);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        return {
          repeated: true,
          message: `Same query as search ${earlier.n} of this run; here is that result again (no search used). Search for something different if it did not help.`,
          result: earlier.result,
        };
      }
      if (used >= limit) {
        return {
          limitReached: true,
          message:
            `This run's ${limit} knowledge searches are used up. Work from the results you have; where the knowledge base does not cover something, ` +
            'say so and give your best answer from general Adobe knowledge, marked as not from the knowledge base.',
        };
      }
      if (!source.execute) throw new Error(`${KNOWLEDGE_SOURCE_TOOL} is not executable on this run.`);
      used++;
      const n = used;
      const result = await source.execute({ query }, options);
      seen.set(key, { n, result });
      return { search: `${n} of ${limit}`, result };
    },
  });
}
