/**
 * Nested traces for agent runs: one span per run, per step, per model call
 * and per tool call, with tokens, latency, model, prompt version and errors.
 *
 * Spans are built from what the AI SDK already reports per step (usage,
 * performance.stepTimeMs / responseTimeMs / toolExecutionMs), so tracing
 * adds no callbacks to the hot path and can't change agent behaviour.
 * Attribute names follow the OpenTelemetry GenAI semantic conventions
 * (gen_ai.*), so any OTLP backend (Langfuse, Arize Phoenix, Jaeger, Honeycomb,
 * Grafana Tempo…) can show them.
 *
 * Export, both optional and both best-effort (a failed export is logged,
 * never thrown into the run):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   OTLP/HTTP JSON; spans POSTed to {endpoint}/v1/traces
 *   OTEL_EXPORTER_OTLP_HEADERS    "key=value,key2=value2" (e.g. an auth header)
 *   OTEL_SERVICE_NAME             default "next-harness"
 *   TRACE_LOG=true                also print each finished run's spans as one JSON line
 *   TRACE_CAPTURE_CONTENT=true    include (truncated) tool arguments/results and step text
 */

import { randomBytes } from 'crypto';

export type AttrValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** Epoch ms. */
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  error?: string;
}

const MAX_CONTENT_CHARS = 2_000;

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function captureContent(): boolean {
  return process.env.TRACE_CAPTURE_CONTENT?.trim().toLowerCase() === 'true';
}

export function contentAttr(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return s.length > MAX_CONTENT_CHARS ? `${s.slice(0, MAX_CONTENT_CHARS)}…` : s;
}

/** What the tracer needs from one finished AI SDK step. */
export interface StepSample {
  stepNumber: number;
  modelId: string;
  provider: string;
  text: string;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  stepTimeMs: number;
  responseTimeMs: number;
  tools: Array<{ callId: string; toolName: string; input: unknown; output?: unknown; error?: string; durationMs?: number }>;
}

export class RunTracer {
  readonly traceId = hex(16);
  private readonly rootId = hex(8);
  private readonly spans: Span[] = [];
  private readonly startMs: number;

  constructor(
    private readonly attrs: Record<string, AttrValue>,
    private readonly now: () => number = Date.now
  ) {
    this.startMs = now();
  }

  /** Record a finished step, called when it ends (its start is derived from stepTimeMs). */
  recordStep(step: StepSample): void {
    const end = this.now();
    const start = end - step.stepTimeMs;
    const stepId = hex(8);
    const capture = captureContent();

    this.spans.push({
      traceId: this.traceId,
      spanId: stepId,
      parentSpanId: this.rootId,
      name: `step ${step.stepNumber + 1}`,
      startMs: start,
      endMs: end,
      attributes: {
        'harness.step': step.stepNumber,
        'gen_ai.response.finish_reasons': step.finishReason,
        ...(capture && step.text ? { 'harness.step.text': contentAttr(step.text) } : {}),
      },
    });

    const modelEnd = start + step.responseTimeMs;
    this.spans.push({
      traceId: this.traceId,
      spanId: hex(8),
      parentSpanId: stepId,
      name: `chat ${step.modelId}`,
      startMs: start,
      endMs: modelEnd,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': step.provider,
        'gen_ai.request.model': step.modelId,
        ...numAttr('gen_ai.usage.input_tokens', step.usage.inputTokens),
        ...numAttr('gen_ai.usage.output_tokens', step.usage.outputTokens),
        ...numAttr('gen_ai.usage.cache_read.input_tokens', step.usage.cacheReadTokens),
        ...numAttr('gen_ai.usage.cache_creation.input_tokens', step.usage.cacheWriteTokens),
      },
    });

    // Tools run after the model responds; the SDK runs a step's calls concurrently.
    for (const t of step.tools) {
      const duration = t.durationMs ?? 0;
      this.spans.push({
        traceId: this.traceId,
        spanId: hex(8),
        parentSpanId: stepId,
        name: `execute_tool ${t.toolName}`,
        startMs: modelEnd,
        endMs: modelEnd + duration,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': t.toolName,
          'gen_ai.tool.call.id': t.callId,
          ...(capture ? { 'gen_ai.tool.call.arguments': contentAttr(t.input) } : {}),
          ...(capture && t.error === undefined ? { 'gen_ai.tool.call.result': contentAttr(t.output) } : {}),
        },
        ...(t.error !== undefined ? { error: t.error } : {}),
      });
    }
  }

  /** Close the run span and return every span of the run, root first. */
  finish(result: { attributes?: Record<string, AttrValue>; error?: string } = {}): Span[] {
    const root: Span = {
      traceId: this.traceId,
      spanId: this.rootId,
      name: 'invoke_agent harness',
      startMs: this.startMs,
      endMs: this.now(),
      attributes: { 'gen_ai.operation.name': 'invoke_agent', ...this.attrs, ...result.attributes },
      ...(result.error ? { error: result.error } : {}),
    };
    return [root, ...this.spans];
  }
}

function numAttr(key: string, value: number | undefined): Record<string, number> {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

// ── Export ────────────────────────────────────────────────────────────────────

function otlpValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

const msToNano = (ms: number) => `${BigInt(Math.round(ms)) * BigInt(1_000_000)}`;

/** OTLP/HTTP JSON body for a set of spans (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding). */
export function toOtlpJson(spans: Span[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: 'next-harness' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.parentSpanId ? 1 : 2, // INTERNAL for children, SERVER for the run
              startTimeUnixNano: msToNano(s.startMs),
              endTimeUnixNano: msToNano(s.endMs),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
              status: s.error ? { code: 2, message: s.error.slice(0, 500) } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** Send a finished run's spans wherever tracing is configured. Never throws. */
export async function exportSpans(spans: Span[]): Promise<void> {
  if (process.env.TRACE_LOG?.trim().toLowerCase() === 'true') {
    console.log(JSON.stringify({ type: 'trace', spans }));
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) },
      body: JSON.stringify(toOtlpJson(spans, process.env.OTEL_SERVICE_NAME?.trim() || 'next-harness')),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[tracing] OTLP export failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('[tracing] OTLP export failed:', err instanceof Error ? err.message : err);
  }
}
