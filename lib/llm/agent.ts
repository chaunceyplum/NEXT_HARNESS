/**
 * The agent loop that replaces the old fixed pipeline:
 *
 *   OLD: planner_parse_natural_language (regex) -> orchestrator_execute (a
 *        tool that doesn't even exist) -> always runs a fixed, monolithic
 *        9-phase build no matter what was actually asked for.
 *
 *   NEW: shortlist the handful of MCP tools relevant to the request (tool
 *        RAG) -> let an LLM (any provider, swappable per call) decide which
 *        of those tools to call, in a loop, based on results so far -> only
 *        reach for the full end-to-end build tool (msb_execute_solution)
 *        when the caller has explicitly opted into it.
 *
 * This is what makes orchestration "dynamic": the tool selection happens
 * per-request based on the actual ask, not a hardcoded chain.
 */

import { generateText, stepCountIs } from 'ai';
import { getDefaultModelKey, resolveModel } from './model-registry';
import { buildAiTools, getMcpToolCatalog, type McpToolDefinition } from './tool-catalog';
import { shortlistTools } from './tool-retrieval';

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

export interface AgentStepTrace {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolResults: Array<{ toolName: string; output: unknown; error?: string }>;
}

export interface AgentRunResult {
  finalText: string;
  steps: AgentStepTrace[];
  toolsConsidered: string[];
  executionId?: string;
  finishReason: string;
}

export interface RunAgentOptions {
  userInput: string;
  /** Model registry key, e.g. "anthropic:haiku". Defaults to DEFAULT_MODEL env var. */
  modelKey?: string;
  /** Must be explicitly true for msb_execute_solution to even be offered to the model. */
  allowFullBuild?: boolean;
  /** Tool-call round trips before the loop is forced to stop. */
  maxSteps?: number;
  /** How many tools the semantic shortlist pulls in, on top of the always-on set. */
  toolShortlistSize?: number;
  /** Extra attempts per failed tool call, each preceded by a RAG lookup for context. 0 disables retrying. */
  toolRetries?: number;
}

function systemPrompt(allowFullBuild: boolean): string {
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
  ].join('\n');
}

/**
 * Every external call in this function (MCP HTTP calls, the embedding
 * provider, the chat model provider) can plausibly fail with the same
 * generic error (e.g. a bare "Forbidden"), and by default that failure is
 * indistinguishable once it reaches the API route's catch block. This
 * tags the error with which stage produced it so a 403/auth failure can
 * actually be traced to "MCP endpoint", "embedding provider", or "chat
 * model provider" instead of just "Forbidden".
 */
async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[${label}] ${message}`, { cause: err });
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const {
    userInput,
    modelKey,
    allowFullBuild = false,
    maxSteps = 10,
    toolShortlistSize = 12,
    toolRetries = 1,
  } = opts;

  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(userInput, {
      k: toolShortlistSize,
      exclude: [...alwaysOn, FULL_BUILD_TOOL],
    })
  );

  const selectedNames = new Set<string>([...alwaysOn, ...shortlisted]);
  if (allowFullBuild && catalogByName.has(FULL_BUILD_TOOL)) {
    selectedNames.add(FULL_BUILD_TOOL);
  }

  const selectedDefs = [...selectedNames]
    .map((name) => catalogByName.get(name))
    .filter((d): d is McpToolDefinition => Boolean(d));

  const tools = buildAiTools(selectedDefs, { maxRetries: toolRetries });
  const resolvedModelKey = modelKey || getDefaultModelKey();

  const result = await stage(`chat model call (${resolvedModelKey})`, () =>
    generateText({
      model: resolveModel(resolvedModelKey),
      system: systemPrompt(allowFullBuild),
      prompt: userInput,
      tools,
      stopWhen: stepCountIs(maxSteps),
    })
  );

  // Walk step.content directly rather than the toolResults convenience
  // array — tool-error content parts (a failed tool call, including one
  // that exhausted its RAG-consulting retries) are NOT included in
  // step.toolResults, only in step.content, and we want failures visible
  // in the trace too.
  const steps: AgentStepTrace[] = result.steps.map((step, i) => {
    const toolCalls: AgentStepTrace['toolCalls'] = [];
    const toolResults: AgentStepTrace['toolResults'] = [];

    for (const part of step.content) {
      if (part.type === 'tool-call') {
        toolCalls.push({ toolName: part.toolName, input: part.input });
      } else if (part.type === 'tool-result') {
        toolResults.push({ toolName: part.toolName, output: part.output });
      } else if (part.type === 'tool-error') {
        const errVal = (part as { error?: unknown }).error;
        toolResults.push({
          toolName: part.toolName,
          output: undefined,
          error: errVal instanceof Error ? errVal.message : String(errVal),
        });
      }
    }

    return { stepNumber: i, text: step.text, toolCalls, toolResults };
  });

  // If any tool returned an execution_id (msb_execute_solution does), surface
  // it so the UI can offer to switch to the async status-polling view.
  let executionId: string | undefined;
  for (const step of steps) {
    for (const r of step.toolResults) {
      const output = r.output;
      if (output && typeof output === 'object' && typeof (output as Record<string, unknown>).execution_id === 'string') {
        executionId = (output as Record<string, unknown>).execution_id as string;
      }
    }
  }

  return {
    finalText: result.text,
    steps,
    toolsConsidered: [...selectedNames],
    executionId,
    finishReason: result.finishReason,
  };
}
