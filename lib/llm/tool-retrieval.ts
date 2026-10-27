/**
 * Tool RAG: semantic search over the MCP tool catalog itself, so the agent
 * never has to see all ~300 tool schemas at once.
 *
 * This is the piece that fixes "asking for a schema ends up calling 50
 * unrelated tools" — instead of handing the model the full catalog, we
 * embed every tool's name+description once, embed the user's request, and
 * hand the model only the top-K most relevant tools (plus whatever
 * always-on / gated tools lib/llm/agent.ts adds on top).
 *
 * The index is computed once per process (in memory) and reused. For a
 * ~300-tool catalog this is a single batch of embedding calls, cheap
 * relative to actually running the agent. If you want it to survive
 * restarts or scale across instances, you already run pgvector for the
 * MCP's own knowledge base (see HARNESS_SUMMARY.md) — storing tool
 * embeddings there instead of in-process is the natural next step.
 *
 * Embeddings require a *second* provider beyond your chat model (Anthropic
 * has no embeddings API — see lib/llm/embeddings.ts), which is unnecessary
 * friction for a Claude-only setup. If the embedding call fails for any
 * reason (no OpenAI/Bedrock configured, auth failure, etc.), this falls
 * back to plain keyword overlap instead of failing the whole agent run —
 * less accurate, but it means tool-shortlisting works with zero additional
 * credentials beyond your chat model's.
 */

import { getMcpToolCatalog, type McpToolDefinition } from './tool-catalog';
import { cosineSimilarity, embedTexts } from './embeddings';

interface ToolIndexEntry {
  name: string;
  embedding: number[];
}

let indexPromise: Promise<ToolIndexEntry[]> | null = null;

function toolText(def: McpToolDefinition): string {
  return `${def.name}: ${def.description || ''}`;
}

async function getToolIndex(): Promise<ToolIndexEntry[]> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const catalog = await getMcpToolCatalog();
      const embeddings = await embedTexts(catalog.map(toolText));
      return catalog.map((def, i) => ({ name: def.name, embedding: embeddings[i] }));
    })().catch((err) => {
      indexPromise = null; // allow retry on next call
      throw err;
    });
  }
  return indexPromise;
}

/** Force recomputation of the tool embedding index (e.g. after the MCP catalog changes). */
export function invalidateToolIndexCache(): void {
  indexPromise = null;
}

/**
 * Start building the tool embedding index now so the first agent run
 * doesn't pay the catalog fetch + embedding batch cost on the critical path.
 * Safe to call at server startup — failures are swallowed (the index will
 * be built on demand when the first run actually needs it).
 */
export function warmUpToolIndex(): void {
  getToolIndex().catch(() => {/* swallow — demand path retries */});
}

export interface ShortlistOptions {
  k?: number;
  /** Tool names to never include (e.g. ones already added as always-on/gated). */
  exclude?: string[];
  /**
   * Only rank tools this predicate accepts (e.g. a run's platform filter).
   * Applied before the top-K cut, so filtered-out tools don't use up slots.
   */
  include?: (name: string) => boolean;
}

// ── Lexical fallback (no embedding provider required) ────────────────────

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

interface LexicalIndexEntry {
  name: string;
  tokens: Set<string>;
}

let lexicalIndexPromise: Promise<LexicalIndexEntry[]> | null = null;

async function getLexicalIndex(): Promise<LexicalIndexEntry[]> {
  if (!lexicalIndexPromise) {
    lexicalIndexPromise = getMcpToolCatalog().then((catalog) =>
      catalog.map((def) => ({ name: def.name, tokens: tokenize(toolText(def)) }))
    );
  }
  return lexicalIndexPromise;
}

async function shortlistToolsLexical(
  query: string,
  k: number,
  exclude: Set<string>,
  include: (name: string) => boolean
): Promise<string[]> {
  const index = await getLexicalIndex();
  const queryTokens = tokenize(query);

  return index
    .filter((entry) => !exclude.has(entry.name) && include(entry.name))
    .map((entry) => {
      let overlap = 0;
      for (const t of queryTokens) if (entry.tokens.has(t)) overlap++;
      return { name: entry.name, score: overlap };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.name);
}

let warnedAboutLexicalFallback = false;

/**
 * After the embedding provider fails, runs go straight to lexical ranking for
 * this long instead of each retrying the whole catalog embed (up to ~300
 * calls, 8 at a time) before falling back.
 */
const EMBEDDING_RETRY_COOLDOWN_MS = 5 * 60_000;
let embeddingsDownUntil = 0;

/** Return the top-K MCP tool names most relevant to `query` (semantic if an embedding provider is configured, lexical otherwise). */
export async function shortlistTools(query: string, opts: ShortlistOptions = {}): Promise<string[]> {
  const k = opts.k ?? 12;
  const exclude = new Set(opts.exclude ?? []);
  const include = opts.include ?? (() => true);

  if (Date.now() < embeddingsDownUntil) return shortlistToolsLexical(query, k, exclude, include);

  try {
    const [index, [queryEmbedding]] = await Promise.all([getToolIndex(), embedTexts([query])]);
    return index
      .filter((entry) => !exclude.has(entry.name) && include(entry.name))
      .map((entry) => ({ name: entry.name, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.name);
  } catch (err) {
    embeddingsDownUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
    if (!warnedAboutLexicalFallback) {
      warnedAboutLexicalFallback = true;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[tool-retrieval] Semantic tool shortlisting unavailable (${message}) — falling back to keyword ` +
          'matching. Set EMBEDDING_PROVIDER=openai (+ OPENAI_API_KEY) or configure Bedrock credentials for ' +
          'more accurate semantic shortlisting.'
      );
    }
    return shortlistToolsLexical(query, k, exclude, include);
  }
}
