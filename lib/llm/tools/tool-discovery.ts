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

const MAX_RESULTS = 5;
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
export function buildDiscoveryTools(
  catalog: McpToolDefinition[],
  callable: ToolSet,
  visibleNames: Set<string>
): ToolSet {
  const index = catalog
    .filter((t) => t.name in callable)
    .map((t) => ({ def: t, text: `${t.name}: ${t.description || ''}`.toLowerCase() }));

  const find_tools = tool({
    description:
      'Search the full tool catalog for a tool you need but do not see in your tool list. ' +
      `Returns up to ${MAX_RESULTS} matches with their input schemas. ` +
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
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const matches = index
        .map((entry) => ({ entry, score: terms.reduce((s, term) => s + (entry.text.includes(term) ? 1 : 0), 0) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map(({ entry: { def } }) => ({
          name: def.name,
          description: (def.description || '').slice(0, MAX_DESCRIPTION_CHARS),
          inputSchema: def.inputSchema,
          directlyAvailable: visibleNames.has(def.name),
        }));
      return {
        tools: matches,
        message: matches.length
          ? 'Call one with call_tool({ tool_name, arguments }), where arguments matches its inputSchema.'
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
