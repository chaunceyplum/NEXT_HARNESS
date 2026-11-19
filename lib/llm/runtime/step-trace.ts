/** Turns SDK steps into trace records and tracing spans, plus the remember_fact tool. */

import { jsonSchema, tool } from 'ai';
import { effectiveToolCall } from '../tools/tool-discovery';
import { type AgentStepTrace, type ToolOutcome } from './agent-core';
import { classifyTool } from '../tools/tool-policy';
import { saveFact } from '../../memory-store';
import { type ApprovalReason } from '../tools/approval-policy';
import { toTokenUsage, type SdkUsage } from '../models/pricing';
import { RunTracer, type StepSample } from '../../tracing';
import { tryGetModelEntry } from './provider-options';

// ── Step trace ────────────────────────────────────────────────────────────────

/**
 * Build a tracing StepSample from a live SDK step and hand it to the tracer.
 * Pulls tokens/timing from step.usage / step.performance and per-tool call
 * data (name, input, output/error, duration) from step.content, keyed to
 * step.performance.toolExecutionMs by tool call id. Provider/model id come
 * from the registry entry for the model that actually ran the step.
 */
export function recordStepSpan(
  tracer: RunTracer,
  step: {
    text: string;
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    };
    content: ReadonlyArray<{ type: string }>;
    performance?: { stepTimeMs?: number; responseTimeMs?: number; toolExecutionMs?: Readonly<Record<string, number>> };
  },
  stepNumber: number,
  modelKey: string
): void {
  const entry = tryGetModelEntry(modelKey);
  const toolMs = step.performance?.toolExecutionMs ?? {};

  type Part = { type: string; toolName?: string; toolCallId?: string; input?: unknown; output?: unknown; result?: unknown; error?: unknown };
  // Pair each tool-call with its result/error part by call id.
  const byId = new Map<string, StepSample['tools'][number]>();
  const order: string[] = [];
  for (const p of step.content as ReadonlyArray<Part>) {
    if (!p.toolCallId || !p.toolName) continue;
    if (p.type === 'tool-call') {
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, { callId: p.toolCallId, toolName: p.toolName, input: p.input, durationMs: toolMs[p.toolCallId] });
    } else if (p.type === 'tool-result') {
      const t = byId.get(p.toolCallId) ?? { callId: p.toolCallId, toolName: p.toolName, input: undefined, durationMs: toolMs[p.toolCallId] };
      t.output = p.output ?? p.result;
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, t);
    } else if (p.type === 'tool-error') {
      const t = byId.get(p.toolCallId) ?? { callId: p.toolCallId, toolName: p.toolName, input: undefined, durationMs: toolMs[p.toolCallId] };
      t.error = p.error instanceof Error ? p.error.message : String(p.error);
      if (!byId.has(p.toolCallId)) order.push(p.toolCallId);
      byId.set(p.toolCallId, t);
    }
  }

  const sample: StepSample = {
    stepNumber,
    modelId: entry?.modelId ?? modelKey,
    provider: entry?.provider ?? 'unknown',
    text: step.text,
    finishReason: step.finishReason ?? '',
    usage: {
      inputTokens: step.usage?.inputTokens,
      outputTokens: step.usage?.outputTokens,
      cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: step.usage?.inputTokenDetails?.cacheWriteTokens,
    },
    stepTimeMs: step.performance?.stepTimeMs ?? 0,
    responseTimeMs: step.performance?.responseTimeMs ?? 0,
    tools: order.map((id) => byId.get(id)!),
  };
  tracer.recordStep(sample);
}

/** Per-step data the AI SDK reports; only the fields the trace reads. */
interface StepForTrace {
  text: string;
  content: ReadonlyArray<{ type: string }>;
  /** step.usage — chat-model tokens for this step. */
  usage?: SdkUsage;
  /** step.performance — timing the SDK measured for this step (streaming steps only for some fields). */
  performance?: { stepTimeMs?: number; responseTimeMs?: number; toolExecutionMs?: Readonly<Record<string, number>> };
}

/**
 * Walk step.content directly — tool-error parts are NOT in step.toolResults
 * but we want them visible in the trace.
 *
 * When the live SDK step is passed (it carries `usage`/`performance`), the
 * trace is enriched with per-step timing/tokens and per-tool durations
 * (step.performance.toolExecutionMs, keyed by tool call id). Re-mapping stored
 * result steps (no performance) just omits those fields.
 */
export function toStepTrace(step: StepForTrace, stepNumber: number): AgentStepTrace {
  const toolCalls: AgentStepTrace['toolCalls'] = [];
  const toolResults: AgentStepTrace['toolResults'] = [];
  const toolMs = step.performance?.toolExecutionMs;

  type Part = {
    type: string;
    toolName: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    result?: unknown;
    error?: unknown;
    approved?: boolean;
    reason?: string;
    toolCall?: { toolName: string };
  };
  for (const part of step.content as ReadonlyArray<Part>) {
    const durationMs = part.toolCallId ? toolMs?.[part.toolCallId] : undefined;
    if (part.type === 'tool-approval-response' && part.approved === false && part.toolCall) {
      // Denied calls never produce a tool-result/tool-error part.
      toolResults.push({ toolName: part.toolCall.toolName, output: undefined, error: `Not executed: ${part.reason ?? 'denied'}` });
    } else if (part.type === 'tool-call') {
      toolCalls.push({ toolName: part.toolName, input: part.input });
    } else if (part.type === 'tool-result') {
      // StaticToolResult uses .output; DynamicToolResult uses .result
      toolResults.push({ toolName: part.toolName, output: part.output ?? part.result, ...(durationMs !== undefined ? { durationMs } : {}) });
    } else if (part.type === 'tool-error') {
      const errVal = part.error;
      toolResults.push({
        toolName: part.toolName,
        output: undefined,
        error: errVal instanceof Error ? errVal.message : String(errVal),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  }

  const perf = step.performance;
  return {
    stepNumber,
    text: step.text,
    toolCalls,
    toolResults,
    ...(perf?.stepTimeMs !== undefined ? { durationMs: perf.stepTimeMs } : {}),
    ...(perf?.responseTimeMs !== undefined ? { modelMs: perf.responseTimeMs } : {}),
    ...(step.usage ? { usage: toTokenUsage(step.usage) } : {}),
  };
}

/** Lets the agent save a verified, stable deployment fact for later runs. */
export function rememberFactTool(runId: string | undefined, actor: string | undefined) {
  return tool({
    description:
      'Save a stable deployment fact for future runs, e.g. key "aep.prod_sandbox", value "prod". Overwrites the same key. Only identifiers you verified with a tool; never credentials or personal data. Lowercase key with letters, digits, "_", "." or "-".',
    inputSchema: jsonSchema<{ key: string; value: string; note?: string }>({
      type: 'object',
      properties: {
        key: { type: 'string', description: 'e.g. "launch.web_property_id"' },
        value: { type: 'string', description: 'The identifier or short fact (max 300 chars).' },
        note: { type: 'string', description: 'Optional: where it came from.' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    }),
    execute: async ({ key, value, note }) => {
      const fact = await saveFact({ key, value, note, sourceRunId: runId, updatedBy: `agent (${actor ?? 'anonymous'})` });
      return { stored: fact.key, value: fact.value };
    },
  });
}

/** One ToolOutcome per finished, failed, or denied call in a step's content. */
export function toolOutcomes(content: ReadonlyArray<{ type: string }>, reasons: Map<string, ApprovalReason>): ToolOutcome[] {
  type Part = {
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    error?: unknown;
    approved?: boolean;
    reason?: string;
    toolCall?: { toolCallId?: string; toolName: string; input?: unknown };
  };
  const out: ToolOutcome[] = [];
  for (const part of content as ReadonlyArray<Part>) {
    let id: string | undefined;
    let raw: { toolName: string; input: unknown } | undefined;
    let outcome: ToolOutcome['outcome'];
    let error: string | undefined;
    if (part.type === 'tool-result' && part.toolName) {
      id = part.toolCallId;
      raw = { toolName: part.toolName, input: part.input };
      outcome = 'ok';
    } else if (part.type === 'tool-error' && part.toolName) {
      id = part.toolCallId;
      raw = { toolName: part.toolName, input: part.input };
      outcome = 'error';
      error = part.error instanceof Error ? part.error.message : String(part.error);
    } else if (part.type === 'tool-approval-response' && part.approved === false && part.toolCall) {
      id = part.toolCall.toolCallId;
      raw = { toolName: part.toolCall.toolName, input: part.toolCall.input };
      outcome = 'denied';
      error = part.reason;
    } else {
      continue;
    }
    const call = effectiveToolCall(raw.toolName, raw.input);
    const approvalReason = id ? reasons.get(id) : undefined;
    out.push({
      toolCallId: id ?? '',
      toolName: call.toolName,
      input: call.input,
      level: classifyTool(call.toolName),
      outcome,
      ...(error !== undefined ? { error } : {}),
      ...(approvalReason ? { approvalReason } : {}),
    });
  }
  return out;
}

