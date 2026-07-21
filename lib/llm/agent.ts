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
import { ALWAYS_ON_TOOLS, FULL_BUILD_TOOL, systemPrompt, stage, type AgentStepTrace } from './agent-core';

export { ALWAYS_ON_TOOLS, FULL_BUILD_TOOL };
export type { AgentStepTrace };

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
