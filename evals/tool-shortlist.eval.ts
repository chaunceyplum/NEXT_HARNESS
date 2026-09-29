/**
 * Tool-shortlisting eval — run manually with `npm run eval:shortlist`.
 *
 * Grades lib/llm/tool-retrieval.ts shortlistTools() against the LIVE MCP
 * catalog: for a realistic request, does the shortlist the agent would
 * actually get contain the tool(s) the task needs? A tool that never makes
 * the shortlist is a tool the model literally cannot call (see
 * buildAiTools), so a miss here is a guaranteed agent failure no prompt
 * change can fix — the cheapest, highest-signal eval in this suite.
 *
 * Mirrors runAgent's own call: the always-on tools are excluded from the
 * ranking (they're added unconditionally) and k defaults to the agent's
 * default toolShortlistSize. No chat model involved — only the embedding
 * provider, or the lexical fallback if none is configured; which one ran is
 * recorded as the run's subject, since they score very differently.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALWAYS_ON_TOOLS } from '@/lib/llm/agent-core';
import { embedTexts } from '@/lib/llm/embeddings';
import { getMcpToolCatalog } from '@/lib/llm/tool-catalog';
import { shortlistTools } from '@/lib/llm/tool-retrieval';
import { loadFixtures } from './lib/fixtures';
import { report, type EvalOutcome } from './lib/report';
import { isMcpConfigured, warnSkip } from './lib/env';
import { gradeShortlist } from './lib/grading';

type ShortlistFixture = {
  id: string;
  note?: string;
  request: string;
  /** Shortlist size; defaults to runAgent's default toolShortlistSize (24). */
  k?: number;
  expectedTools: string[];
  /** Fraction of expectedTools that must appear. Defaults to 1 (all of them). */
  minRecall?: number;
};

const DEFAULT_K = 24;

const configured = isMcpConfigured();
if (!configured) warnSkip('tool-shortlist eval', 'MCP_ENDPOINT_URL is not set (the live catalog is what is being searched).');

const results: EvalOutcome[] = [];
const startedAt = new Date();
let subject = 'unknown';
afterAll(() =>
  report({ suite: 'tool_shortlist', label: 'Tool shortlisting (shortlistTools)', subject, startedAt, results })
);

describe.skipIf(!configured)('Tool shortlist eval (shortlistTools)', () => {
  const fixtures = loadFixtures<ShortlistFixture>('tool-shortlist');
  let catalogNames = new Set<string>();

  beforeAll(async () => {
    catalogNames = new Set((await getMcpToolCatalog()).map((t) => t.name));
    // shortlistTools falls back to keyword matching silently on an
    // embedding failure; probe once so the report says which mode was graded.
    try {
      await embedTexts(['probe']);
      subject = `embeddings:${process.env.EMBEDDING_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'bedrock')}`;
    } catch {
      subject = 'lexical-fallback';
    }
  });

  it.each(fixtures)('$id', async (fixture) => {
    const t0 = Date.now();
    const notes: string[] = [];
    let passed = false;

    // A fixture naming a tool the server no longer exposes is stale, not a retrieval miss.
    const stale = fixture.expectedTools.filter((name) => !catalogNames.has(name));
    if (stale.length) {
      notes.push(`fixture stale: not in live catalog: ${stale.join(', ')}`);
    } else {
      const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogNames.has(name));
      const k = fixture.k ?? DEFAULT_K;
      const shortlist = await shortlistTools(fixture.request, { k, exclude: alwaysOn });
      const grade = gradeShortlist(shortlist, fixture.expectedTools);
      const minRecall = fixture.minRecall ?? 1;
      passed = grade.recall >= minRecall;

      const ranks = Object.entries(grade.ranks).map(([name, rank]) => `${name}@${rank}`);
      notes.push(`recall ${Math.round(grade.recall * 100)}% (need ${Math.round(minRecall * 100)}%) in top ${k}`);
      if (ranks.length) notes.push(`found ${ranks.join(', ')}`);
      if (grade.missing.length) notes.push(`missing ${grade.missing.join(', ')}; top 5 were ${shortlist.slice(0, 5).join(', ')}`);
    }

    results.push({ fixtureId: fixture.id, passed, notes: notes.join('; '), durationMs: Date.now() - t0 });
    expect.soft(passed, notes.join('; ')).toBe(true);
  });
});
