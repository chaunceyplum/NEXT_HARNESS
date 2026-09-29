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
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import type { RecordedCall } from './grading';

/** One canned response: `result` is returned to the model, `error` is thrown as a tool error. */
export type ScriptedResponse = { result: unknown } | { error: string };

export interface ScriptedToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. Defaults to an open object. */
  inputSchema?: Record<string, unknown>;
  /** Consumed in order, one per call; the last one repeats once the queue runs out. Defaults to `{ result: { ok: true } }`. */
  responses?: ScriptedResponse[];
}

const OPEN_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

export function buildScriptedTools(defs: ScriptedToolDef[]): { tools: ToolSet; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const tools: ToolSet = {};

  for (const def of defs) {
    const responses = def.responses?.length ? def.responses : [{ result: { ok: true } }];
    let n = 0;
    tools[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema((def.inputSchema ?? OPEN_OBJECT_SCHEMA) as never),
      execute: async (input: unknown) => {
        calls.push({ toolName: def.name, input });
        const response = responses[Math.min(n++, responses.length - 1)];
        if ('error' in response) throw new Error(response.error);
        return response.result;
      },
    });
  }

  return { tools, calls };
}
