/**
 * Scripted stand-ins for MCP tools, for the agent eval. Each fixture tool
 * has a name, the description the model sees, and a queue of canned
 * responses; every call is recorded so the trajectory can be graded.
 *
 * Why not the live MCP server: most tools in this catalog WRITE to a real
 * AEP/CJA/Reactor org. Grading "does the agent pick the right tool and stop
 * when it should" must not create schemas or delete segments as a side
 * effect, and must be repeatable — so the platform is scripted and only the
 * model is real. Fixture descriptions should be copied from the live
 * catalog (tools/list) so the model sees what it sees in production.
 *
 * Scripted tools bypass executeMcpToolWithRetry's retry / grounding
 * (tool-catalog.ts) — that path makes live knowledge-base calls, and it's
 * the model's own retry behavior being graded here, not the harness's.
 *
 * Answer selection is by TOOL NAME + INPUT, independent of call order
 * (Requirement 16.1). Under orchestration the coordinator runs independent
 * steps as concurrent workers, so two tools' calls interleave in a
 * non-deterministic order; a single global "next in queue" counter would hand
 * a call the response meant for a different call. Each tool keeps its own
 * queue, and a response may carry a `when` matcher that pins it to the inputs
 * it answers for — so the same input always gets the same answer no matter
 * when, or in what order, it is called. Responses without a matcher still fall
 * back to per-tool queue order, so every existing fixture behaves exactly as
 * before (single-agent runs call each tool's responses in the order written).
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import type { RecordedCall } from './grading';

/**
 * How a response is matched to a call's input, when the response is not just
 * next in the queue. Every listed field must be present in the call's input,
 * compared as a case-insensitive substring of the JSON-serialized value — the
 * same shape as the trajectory grader's `argsContain`, so fixtures express a
 * match the same way they express an assertion.
 */
export type ResponseMatch = Record<string, string | number | boolean>;

/** One canned response: `result` is returned to the model, `error` is thrown as a tool error. */
export type ScriptedResponse = ({ result: unknown } | { error: string }) & {
  /**
   * When set, this response answers only calls whose input matches every
   * entry (name + input, independent of call order). Responses without
   * `when` are consumed in queue order, as a fallback.
   */
  when?: ResponseMatch;
};

export interface ScriptedToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. Defaults to an open object. */
  inputSchema?: Record<string, unknown>;
  /** Consumed in order, one per call; the last one repeats once the queue runs out. Defaults to `{ result: { ok: true } }`. */
  responses?: ScriptedResponse[];
}

const OPEN_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

/**
 * Does a call's input satisfy a response's `when` matcher? Each field's value
 * must appear (case-insensitively) somewhere in the JSON serialization of the
 * input's value for that key — robust to the model nesting the value, passing
 * it as a stringified JSON blob, or varying case.
 */
function matchesInput(input: unknown, when: ResponseMatch): boolean {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return Object.entries(when).every(([key, expected]) => {
    const actual = record[key];
    if (actual === undefined) return false;
    return JSON.stringify(actual).toLowerCase().includes(String(expected).toLowerCase());
  });
}

export function buildScriptedTools(defs: ScriptedToolDef[]): { tools: ToolSet; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const tools: ToolSet = {};

  for (const def of defs) {
    const responses = def.responses?.length ? def.responses : [{ result: { ok: true } }];
    // A response without `when` is consumed in order; one with `when` is
    // selected by input and never consumed, so it can answer repeatedly.
    const unmatched = responses.filter((r) => !r.when);
    let n = 0;
    tools[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema((def.inputSchema ?? OPEN_OBJECT_SCHEMA) as never),
      execute: async (input: unknown) => {
        calls.push({ toolName: def.name, input });
        // Prefer a matcher pinned to this input (order-independent); fall back
        // to the next unmatched response in queue order, repeating the last.
        const matched = responses.find((r) => r.when && matchesInput(input, r.when));
        const response = matched ?? unmatched[Math.min(n++, unmatched.length - 1)] ?? { result: { ok: true } };
        if ('error' in response) throw new Error(response.error);
        return response.result;
      },
    });
  }

  return { tools, calls };
}
