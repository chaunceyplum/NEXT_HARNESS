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

export interface ShortlistOptions {
  k?: number;
  /** Tool names to never include (e.g. ones already added as always-on/gated). */
  exclude?: string[];
}

/** Return the top-K MCP tool names most semantically relevant to `query`. */
export async function shortlistTools(query: string, opts: ShortlistOptions = {}): Promise<string[]> {
  const k = opts.k ?? 12;
  const exclude = new Set(opts.exclude ?? []);

  const [index, [queryEmbedding]] = await Promise.all([getToolIndex(), embedTexts([query])]);

  return index
    .filter((entry) => !exclude.has(entry.name))
    .map((entry) => ({ name: entry.name, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.name);
}
