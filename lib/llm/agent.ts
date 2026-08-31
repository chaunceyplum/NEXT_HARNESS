/**
 * The agent loop that replaces the old fixed pipeline:
 *
 *   OLD: planner_parse_natural_language (regex) -> orchestrator_execute (a
 *        tool that doesn't even exist) -> always runs a fixed, monolithic
 *        build no matter what was actually asked for.
 *
 *   NEW: shortlist the handful of MCP tools relevant to the request (tool
 *        RAG) -> let an LLM (any provider, swappable per call) decide which
 *        of those tools to call, in a loop, based on results so far.
 *
 * This is what makes orchestration "dynamic": the tool selection happens
 * per-request based on the actual ask, not a hardcoded chain. There is no
 * full end-to-end build tool wired up here — the MCP server the harness
 * currently talks to has no such tool in its catalog (verified against its
 * live tools/list, Aug 2026), so every request resolves through specific,
 * narrow tool calls.
 */

import { generateText, stepCountIs } from 'ai';
import { getDefaultModelKey, resolveModel } from './model-registry';
import { buildAiTools, getMcpToolCatalog, type McpToolDefinition } from './tool-catalog';
import { shortlistTools } from './tool-retrieval';
import { ALWAYS_ON_TOOLS, systemPrompt, stage, type AgentStepTrace } from './agent-core';

export { ALWAYS_ON_TOOLS };
export type { AgentStepTrace };

/**
 * Chat-model token usage for one run, summed across every step of the
 * agent loop (generateText's `usage` is already the all-steps total, not
 * just the final step — see the AI SDK's GenerateTextResult docs). Does
 * NOT include the tool-shortlisting embedding call or any RAG-judge calls
 * (lib/llm/rag-judge.ts) — both are real but comparatively small costs;
 * this covers the dominant one (the actual chat model) without threading
 * usage through every side call.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentRunResult {
  finalText: string;
  steps: AgentStepTrace[];
  toolsConsidered: string[];
  finishReason: string;
  usage: TokenUsage;
}

export interface RunAgentOptions {
  userInput: string;
  /** Model registry key, e.g. "anthropic:haiku". Defaults to DEFAULT_MODEL env var. */
  modelKey?: string;
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
    maxSteps = 20,
    toolShortlistSize = 24,
    toolRetries = 1,
  } = opts;

  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(userInput, {
      k: toolShortlistSize,
      exclude: alwaysOn,
    })
  );

  const selectedNames = new Set<string>([...alwaysOn, ...shortlisted]);

  const selectedDefs = [...selectedNames]
    .map((name) => catalogByName.get(name))
    .filter((d): d is McpToolDefinition => Boolean(d));

  const tools = buildAiTools(selectedDefs, { maxRetries: toolRetries });
  const resolvedModelKey = modelKey || getDefaultModelKey();

  const result = await stage(`chat model call (${resolvedModelKey})`, () =>
    generateText({
      model: resolveModel(resolvedModelKey),
      system: systemPrompt(),
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

  return {
    finalText: result.text,
    steps,
    toolsConsidered: [...selectedNames],
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
