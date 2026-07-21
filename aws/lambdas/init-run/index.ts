/**
 * InitRun — first state of the harness-agent-loop state machine.
 *
 * Ports the setup half of lib/llm/agent.ts's old runAgent(): fetch the MCP
 * tool catalog, shortlist relevant tools (tool RAG), union with the
 * always-on grounding tools, add the full-build tool only if explicitly
 * allowed (invariant: never offered otherwise) — then persist the selected
 * tool set + initial message so every later step rebuilds the exact same
 * tool set without re-running embeddings.
 */

import { getMcpToolCatalog, type McpToolDefinition } from '@/lib/llm/tool-catalog';
import { shortlistTools } from '@/lib/llm/tool-retrieval';
import { ALWAYS_ON_TOOLS, FULL_BUILD_TOOL, stage } from '@/lib/llm/agent-core';
import { createRun } from '@/lib/execution-store';
import { asStateStoreError } from '../_shared/errors';
import type { LoopEnvelope } from '../_shared/envelope';

export interface InitRunInput {
  runId: string;
  description: string;
  modelKey: string;
  allowFullBuild: boolean;
  maxSteps: number;
  toolShortlistSize: number;
  toolRetries: number;
  /** Populated by the ASL via $$.Execution.Id — see the InitRun state's Parameters. */
  sfnExecutionArn?: string;
}

export const handler = async (event: InitRunInput): Promise<LoopEnvelope> => {
  const { runId, description, modelKey, allowFullBuild, maxSteps, toolShortlistSize, sfnExecutionArn } = event;

  const catalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  const alwaysOn = ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name));
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(description, {
      k: toolShortlistSize,
      exclude: [...alwaysOn, FULL_BUILD_TOOL],
    })
  );

  const selectedNames = new Set<string>([...alwaysOn, ...shortlisted]);
  if (allowFullBuild && catalogByName.has(FULL_BUILD_TOOL)) {
    selectedNames.add(FULL_BUILD_TOOL);
  }

  const selectedTools: McpToolDefinition[] = [...selectedNames]
    .map((name) => catalogByName.get(name))
    .filter((d): d is McpToolDefinition => Boolean(d));

  await asStateStoreError(() =>
    stage('state store (createRun)', () =>
      createRun({
        id: runId,
        description,
        model: modelKey,
        allowFullBuild,
        selectedTools,
        messages: [{ role: 'user', content: description }],
        sfnExecutionArn,
      })
    )
  );

  // Routes straight into AgentStep next regardless of this value (see the
  // ASL's InitRun.Next) — kept TOOL_CALLS for envelope-shape consistency
  // with every other state's output.
  return { runId, stepCount: 0, status: 'TOOL_CALLS', maxSteps };
};
