/**
 * TASK 6: mid-run tool discovery without changing the tool list.
 *
 * The model's tool list is fixed for the whole run (the shortlist, plus these
 * two). Adding tools to it mid-run would invalidate the prompt cache and, on
 * models that bind thinking to the prior conversation, get the request
 * rejected (see HISTORY_BOUND_MODEL_RE in agent.ts). Instead:
 *
 *   find_tools(query)          searches every tool the policy allows and
 *                              returns names, descriptions and input schemas
 *   call_tool(tool_name, args) runs one of those by name
 *
 * call_tool executes the same policy-filtered, dry-run-wrapped tool object a
 * shortlisted tool would use, and agent.ts's approval gate / side-effect
 * tracking unwrap it via effectiveToolCall — so routing a call through the
 * proxy never skips a safety check.
 */

import { tool, jsonSchema, type ToolSet } from 'ai';
import type { McpToolDefinition } from './tool-catalog';

const MAX_RESULTS = 8;
/** Matches returned with their full input schema; the rest carry name + description only, to bound the result size. */
const MAX_WITH_SCHEMA = 4;
const MAX_DESCRIPTION_CHARS = 400;

/** The underlying tool a call targets — unwraps call_tool to the tool it proxies. */
export function effectiveToolCall(toolName: string, input: unknown): { toolName: string; input: unknown } {
  if (toolName !== 'call_tool' || !input || typeof input !== 'object') return { toolName, input };
  const { tool_name, arguments: args } = input as { tool_name?: unknown; arguments?: unknown };
  return typeof tool_name === 'string' ? { toolName: tool_name, input: args ?? {} } : { toolName, input };
}

/**
 * @param catalog      the full MCP catalog (for descriptions/schemas)
 * @param callable     every tool the policy allows, keyed by name
 * @param visibleNames tools the model can already call directly
 */
/**
 * Optional semantic ranker for find_tools: the most relevant callable tool
 * names for a query, best first (tool-selection.ts passes the embedding
 * shortlist, which falls back to keywords itself). May reject; find_tools
 * then ranks on keywords alone.
 */
export type ToolRanker = (query: string, k: number, include: (name: string) => boolean) => Promise<string[]>;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/**
 * Keyword score for one tool: query words found among the tool NAME's words
 * count 3, in its description 1, and a tool whose name holds every query
 * word gets a bonus — so "delete segment" puts adobe_delete_segment above
 * every tool whose description merely mentions segments. Plural/singular
 * are folded ("segments" ~ "segment").
 */
export function keywordScore(query: string, name: string, description: string): number {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return 0;
  const nameTokens = new Set(tokens(name));
  const descTokens = new Set(tokens(description));
  let score = 0;
  let inName = 0;
  for (const t of q) {
    if (nameTokens.has(t)) {
      score += 3;
      inName++;
    } else if (descTokens.has(t)) score += 1;
  }
  if (inName === q.length) score += 2;
  return score;
}

/**
 * @param catalog      the full MCP catalog (for descriptions/schemas)
 * @param callable     every tool the policy allows, keyed by name
 * @param visibleNames tools the model can already call directly
 * @param rank         optional semantic ranker (see ToolRanker)
 */
export function buildDiscoveryTools(
  catalog: McpToolDefinition[],
  callable: ToolSet,
  visibleNames: Set<string>,
  rank?: ToolRanker
): ToolSet {
  const index = catalog.filter((t) => t.name in callable);
  const byName = new Map(index.map((t) => [t.name, t]));

  const find_tools = tool({
    description:
      'Search the full tool catalog for a tool you need but do not see in your tool list. ' +
      `Returns up to ${MAX_RESULTS} matches, the best ${MAX_WITH_SCHEMA} with their input schemas. ` +
      'Call a match through call_tool (or directly, if it is already in your tool list).',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A short phrase describing the capability you need, e.g. "get merge policy" or "delete segment".',
        },
      },
      required: ['query'],
    }),
    execute: async ({ query }: { query: string }) => {
      // Keyword score for every callable tool, plus a bonus by semantic rank:
      // the embedding ranker finds tools phrased differently from the query
      // ("audience" → segments), keywords keep exact name matches on top.
      const semantic = rank ? await rank(query, MAX_RESULTS * 2, (n) => byName.has(n)).catch(() => [] as string[]) : [];
      const semanticBonus = new Map(semantic.map((n, i) => [n, (semantic.length - i) / semantic.length * 3]));
      const matches = index
        .map((def) => ({ def, score: keywordScore(query, def.name, def.description || '') + (semanticBonus.get(def.name) ?? 0) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map(({ def }, i) => ({
          name: def.name,
          description: (def.description || '').slice(0, MAX_DESCRIPTION_CHARS),
          ...(i < MAX_WITH_SCHEMA ? { inputSchema: def.inputSchema } : {}),
          directlyAvailable: visibleNames.has(def.name),
        }));
      return {
        tools: matches,
        message: matches.length
          ? 'Call one with call_tool({ tool_name, arguments }), where arguments matches its inputSchema. ' +
            'A match listed without an inputSchema: call find_tools with its exact name to get it.'
          : 'No matching tools. Try different wording, or say in your answer that no tool covers this.',
      };
    },
  });

  const call_tool = tool({
    description:
      'Run a tool found with find_tools by name. `arguments` must match that tool\'s inputSchema. ' +
      'Subject to the same access policy, dry-run mode and approval rules as any other tool.',
    inputSchema: jsonSchema<{ tool_name: string; arguments?: Record<string, unknown> }>({
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name returned by find_tools.' },
        arguments: { type: 'object', description: "The tool's arguments, matching its inputSchema.", additionalProperties: true },
      },
      required: ['tool_name'],
    }),
    // `options` (toolCallId, messages, abortSignal) is forwarded to the target as-is.
    execute: async ({ tool_name, arguments: args }, options) => {
      const target = tool_name === 'call_tool' || tool_name === 'find_tools' ? undefined : callable[tool_name];
      if (!target?.execute) {
        throw new Error(
          `Tool "${tool_name}" is not available on this run (unknown, or removed by the access policy). Use find_tools to search.`
        );
      }
      return target.execute(args ?? {}, options);
    },
  });

  return { find_tools, call_tool };
}
