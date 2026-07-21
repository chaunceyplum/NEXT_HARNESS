/**
 * ExecTools — runs the tool calls AgentStep proposed, sequentially (matches
 * today's in-process behavior: buildAiTools' execute functions run one at a
 * time within a generateText step, not concurrently).
 *
 * Reuses executeMcpToolWithRetry (lib/llm/tool-catalog.ts) verbatim, so the
 * RAG-consulting retry behavior — the isRagTool no-retry guard, the
 * prefix-routed grounding lookup, the _retryHistory attachment on
 * success-after-retry, the retry-history-embedded exhaustion error — is
 * bit-for-bit the same code path the old in-process agent used, not a
 * reimplementation that could drift from it.
 *
 * A tool failure here is deliberately NOT a state-machine failure: it's fed
 * back to the model as a tool-result error (type: 'error-text') so the next
 * AgentStep sees it and can react, exactly like the in-process agent's
 * tool-error content parts did. Only infra-level failures (Postgres via
 * execute_sql being unreachable) throw StateStoreError and let the ASL's
 * Retry/Catch handle it.
 */

import type { JSONValue, ModelMessage, ToolResultPart } from 'ai';
import { executeMcpToolWithRetry } from '@/lib/llm/tool-catalog';
import { loadRun, checkpointStep } from '@/lib/execution-store';
import { asStateStoreError } from '../_shared/errors';
import type { LoopEnvelope } from '../_shared/envelope';

const TOOL_RETRIES = Number(process.env.TOOL_RETRIES ?? 1);

export const handler = async (env: LoopEnvelope): Promise<LoopEnvelope> => {
  const run = await asStateStoreError(() => loadRun(env.runId));
  const calls = run.pendingToolCalls ?? [];
  const availableNames = new Set(run.selectedTools.map((t) => t.name));

  const toolResultParts: ToolResultPart[] = [];
  let msbExecutionId: string | undefined;

  for (const call of calls) {
    try {
      const output = await executeMcpToolWithRetry(call.toolName, (call.input as Record<string, unknown>) ?? {}, {
        maxRetries: TOOL_RETRIES,
        availableNames,
      });

      // Surface execution_id (typically from msb_execute_solution) onto the
      // run the same way the old in-process agent did, so the UI can offer
      // to switch to the MSB status-polling view.
      if (output && typeof output === 'object' && typeof (output as Record<string, unknown>).execution_id === 'string') {
        msbExecutionId = (output as Record<string, unknown>).execution_id as string;
      }

      toolResultParts.push({
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value: output as JSONValue },
      });
    } catch (err) {
      toolResultParts.push({
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'error-text', value: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const toolMessage: ModelMessage = { role: 'tool', content: toolResultParts };

  await asStateStoreError(() =>
    checkpointStep(env.runId, {
      newMessages: [toolMessage],
      pendingToolCalls: null,
      status: 'RUNNING',
      msbExecutionId,
    })
  );

  return { ...env, status: 'TOOL_CALLS' };
};
