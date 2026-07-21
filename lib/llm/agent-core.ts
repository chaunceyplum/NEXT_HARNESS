/**
 * Shared agent building blocks used by both the in-process agent loop
 * (lib/llm/agent.ts, kept for the synchronous `?sync=1` cutover path) and
 * the Step Functions `agent-step`/`init-run` Lambdas (aws/lambdas/). Moved
 * here so neither side re-implements the system prompt or tool-set
 * invariants and drifts from the other.
 *
 * Rebuilt fresh on every call rather than persisted — a prompt fix or a
 * change to ALWAYS_ON_TOOLS applies to in-flight Step Functions runs on
 * next deploy without needing a migration.
 */

/**
 * Cheap, read-only, grounding tools. Always available regardless of the
 * shortlist, so the model can look things up before acting even if
 * embedding search didn't happen to rank them highly for this query.
 */
export const ALWAYS_ON_TOOLS = [
  'search_adobe_knowledge',
  'search_aws_knowledge',
  'search_data_eng_knowledge',
  'planner_find_similar',
  'planner_validate_config',
];

/**
 * Full end-to-end martech build. Runs all 9 phases (EDDL, Launch, deploy,
 * AEP foundation, audiences, CJA, AJO, personalization) with real side
 * effects across GitHub/Netlify/Adobe/AWS. Never included in the agent's
 * tool set unless the caller explicitly opts in via allowFullBuild.
 */
export const FULL_BUILD_TOOL = 'msb_execute_solution';

export function systemPrompt(allowFullBuild: boolean): string {
  return [
    'You are an autonomous MarTech engineering assistant with direct tool access to Adobe Experience Platform, AWS, Databricks, Snowflake, and a solutions-architecture knowledge base.',
    '',
    'Rules:',
    '- Always prefer the narrowest tool that satisfies the request. Do not call broad or unrelated tools "just in case" — you only have the tools relevant to this request available, so trust that the ones you see are the ones worth considering.',
    '- When it would help, ground yourself first with the knowledge-search tools (search_adobe_knowledge, search_aws_knowledge, search_data_eng_knowledge) before taking action.',
    '- If you construct a solution config, validate it with planner_validate_config before acting on it.',
    allowFullBuild
      ? `- ${FULL_BUILD_TOOL} runs a full 9-phase end-to-end build (schema, Launch, deploy, audiences, CJA, AJO, personalization) with real side effects across multiple systems. Only call it when the user has explicitly asked for a complete, end-to-end solution build. For anything narrower ("create a schema", "list my segments", "check my query history"), use the specific narrow tool instead.`
      : `- You do NOT have access to the full end-to-end build tool in this run. If the request genuinely requires a full multi-phase build, say so in your final answer and explain that the user needs to enable "allow full build" rather than trying to approximate it with other tools.`,
    '- After acting, briefly explain what you did and why in your final answer.',
    '- Some high-impact tools require human approval before execution. If a reviewer rejects a proposed action, the rejection and their feedback will appear as that tool call\'s result — revise your approach accordingly instead of re-proposing the identical call.',
  ].join('\n');
}

/**
 * Every external call in the agent loop (MCP HTTP calls, the embedding
 * provider, the chat model provider) can plausibly fail with the same
 * generic error (e.g. a bare "Forbidden"), and by default that failure is
 * indistinguishable once it reaches the caller's catch block. This tags the
 * error with which stage produced it so a 403/auth failure can actually be
 * traced to "MCP endpoint", "embedding provider", or "chat model provider"
 * instead of just "Forbidden".
 */
export async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[${label}] ${message}`, { cause: err });
  }
}

export interface AgentStepTrace {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolResults: Array<{ toolName: string; output: unknown; error?: string }>;
}

/**
 * Minimal shape this needs from an AI SDK ModelMessage — kept structural
 * (not `import type { ModelMessage } from 'ai'`) so this file has no
 * dependency on exact `ai` package content-part types, only on the specific
 * fields it reads.
 */
interface TraceableMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Reconstructs the old in-process agent's step-by-step trace shape from the
 * message history the Step Functions loop persists — one assistant message
 * (AgentStep's output) optionally followed by one tool message (ExecTools'
 * output) becomes one AgentStepTrace, so the existing AgentTrace UI
 * component renders a Step-Functions-backed run identically to a
 * synchronous one. Used by both the finalize Lambda (aws/lambdas/finalize)
 * and GET /api/runs/[id] (for in-progress runs, before finalize has run).
 */
export function deriveTraceFromMessages(rawMessages: unknown[]): { steps: AgentStepTrace[]; finalText: string } {
  const messages = rawMessages as TraceableMessage[];
  const steps: AgentStepTrace[] = [];
  let stepNumber = 0;
  let finalText = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;

    const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;

    const toolCalls: AgentStepTrace['toolCalls'] = [];
    let text = '';
    for (const part of parts) {
      if (part.type === 'text') text += (part as unknown as { text: string }).text;
      else if (part.type === 'tool-call') {
        const p = part as unknown as { toolName: string; input: unknown };
        toolCalls.push({ toolName: p.toolName, input: p.input });
      }
    }

    const toolResults: AgentStepTrace['toolResults'] = [];
    const next = messages[i + 1];
    if (next && next.role === 'tool' && Array.isArray(next.content)) {
      for (const part of next.content) {
        if (part.type !== 'tool-result') continue;
        const toolName = (part as unknown as { toolName: string }).toolName;
        const output = (part as unknown as { output: { type: string; value?: unknown } }).output;
        if (output?.type === 'json' || output?.type === 'content') {
          toolResults.push({ toolName, output: output.value });
        } else if (output?.type === 'error-text' || output?.type === 'error-json') {
          toolResults.push({ toolName, output: undefined, error: String(output.value) });
        } else {
          toolResults.push({ toolName, output });
        }
      }
    }

    steps.push({ stepNumber: stepNumber++, text, toolCalls, toolResults });
    if (text) finalText = text;
  }

  return { steps, finalText };
}
