import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunTracer, toOtlpJson, exportSpans, contentAttr, type StepSample, type Span } from './tracing';

/** A monotonically increasing clock so span timings are deterministic. */
function fakeClock(start = 1_000): () => number {
  let t = start;
  return () => (t += 100);
}

function sampleStep(over: Partial<StepSample> = {}): StepSample {
  return {
    stepNumber: 0,
    modelId: 'claude-haiku-4-5',
    provider: 'anthropic',
    text: 'thinking',
    finishReason: 'tool-calls',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 },
    stepTimeMs: 500,
    responseTimeMs: 300,
    tools: [{ callId: 'call-1', toolName: 'adobe_list_segments', input: { limit: 5 }, output: { items: [] }, durationMs: 150 }],
    ...over,
  };
}

const byName = (spans: Span[], name: string) => spans.find((s) => s.name === name);
const startsWith = (spans: Span[], prefix: string) => spans.find((s) => s.name.startsWith(prefix));

describe('RunTracer span tree', () => {
  it('builds run → step → chat + execute_tool spans with a shared trace id', () => {
    const tracer = new RunTracer({ 'harness.prompt.version': 'abc123' }, fakeClock());
    tracer.recordStep(sampleStep());
    const spans = tracer.finish({ attributes: { 'harness.model.key': 'anthropic:haiku' } });

    const root = spans[0];
    expect(root.name).toBe('invoke_agent harness');
    expect(root.parentSpanId).toBeUndefined();
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.attributes['harness.prompt.version']).toBe('abc123');
    expect(root.attributes['harness.model.key']).toBe('anthropic:haiku');

    // Every span shares the run's trace id.
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([root.traceId]));

    const step = startsWith(spans, 'step 1')!;
    expect(step.parentSpanId).toBe(root.spanId);

    const chat = startsWith(spans, 'chat ')!;
    expect(chat.parentSpanId).toBe(step.spanId);
    expect(chat.attributes['gen_ai.request.model']).toBe('claude-haiku-4-5');
    expect(chat.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(100);
    expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(20);
    expect(chat.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(80);

    const tool = startsWith(spans, 'execute_tool ')!;
    expect(tool.parentSpanId).toBe(step.spanId);
    expect(tool.attributes['gen_ai.tool.name']).toBe('adobe_list_segments');
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('call-1');
    // durationMs (150) is reflected in the span window.
    expect(tool.endMs - tool.startMs).toBe(150);
  });

  it('records a span per step', () => {
    const tracer = new RunTracer({}, fakeClock());
    tracer.recordStep(sampleStep({ stepNumber: 0 }));
    tracer.recordStep(sampleStep({ stepNumber: 1, tools: [] }));
    const spans = tracer.finish();
    expect(spans.filter((s) => s.name.startsWith('step ')).length).toBe(2);
    expect(byName(spans, 'step 2')).toBeDefined();
  });

  it('propagates a tool error onto the tool span', () => {
    const tracer = new RunTracer({}, fakeClock());
    tracer.recordStep(
      sampleStep({ tools: [{ callId: 'c', toolName: 'adobe_delete_segment', input: {}, error: 'HTTP 500' }] })
    );
    const tool = startsWith(tracer.finish(), 'execute_tool ')!;
    expect(tool.error).toBe('HTTP 500');
  });

  it('carries an error onto the run span when the run failed', () => {
    const tracer = new RunTracer({}, fakeClock());
    const spans = tracer.finish({ error: 'provider outage' });
    expect(spans[0].error).toBe('provider outage');
  });

  it('omits captured content unless TRACE_CAPTURE_CONTENT=true', () => {
    const tracer = new RunTracer({}, fakeClock());
    tracer.recordStep(sampleStep());
    const tool = startsWith(tracer.finish(), 'execute_tool ')!;
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
  });

  it('includes captured content when TRACE_CAPTURE_CONTENT=true', () => {
    process.env.TRACE_CAPTURE_CONTENT = 'true';
    try {
      const tracer = new RunTracer({}, fakeClock());
      tracer.recordStep(sampleStep());
      const tool = startsWith(tracer.finish(), 'execute_tool ')!;
      expect(tool.attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify({ limit: 5 }));
      expect(tool.attributes['gen_ai.tool.call.result']).toBe(JSON.stringify({ items: [] }));
    } finally {
      delete process.env.TRACE_CAPTURE_CONTENT;
    }
  });
});

describe('contentAttr', () => {
  it('truncates long values', () => {
    const out = contentAttr('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(2001);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('toOtlpJson', () => {
  it('produces resourceSpans with the service name and typed attribute values', () => {
    const tracer = new RunTracer({ 'harness.app.version': 'dev', 'harness.cost_usd': 0.0012 }, fakeClock());
    tracer.recordStep(sampleStep());
    const otlp = toOtlpJson(tracer.finish(), 'next-harness') as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeSpans: Array<{ spans: Array<{ name: string; startTimeUnixNano: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status: { code: number } }> }>;
      }>;
    };

    const rs = otlp.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'next-harness' } });

    const spans = rs.scopeSpans[0].spans;
    const root = spans.find((s) => s.name === 'invoke_agent harness')!;
    // nanosecond strings
    expect(root.startTimeUnixNano).toMatch(/^\d+$/);
    // integer vs double attribute encoding
    const cost = root.attributes.find((a) => a.key === 'harness.cost_usd')!;
    expect(cost.value).toEqual({ doubleValue: 0.0012 });
    const app = root.attributes.find((a) => a.key === 'harness.app.version')!;
    expect(app.value).toEqual({ stringValue: 'dev' });
    // OK status when no error
    expect(root.status.code).toBe(1);
  });

  it('marks errored spans with status code 2 and the message', () => {
    const tracer = new RunTracer({}, fakeClock());
    const otlp = toOtlpJson(tracer.finish({ error: 'boom' }), 'svc') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number; message?: string } }> }> }>;
    };
    const status = otlp.resourceSpans[0].scopeSpans[0].spans[0].status;
    expect(status.code).toBe(2);
    expect(status.message).toBe('boom');
  });
});

describe('exportSpans', () => {
  const spans: Span[] = [
    { traceId: 't', spanId: 's', name: 'invoke_agent harness', startMs: 0, endMs: 1, attributes: {} },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.TRACE_LOG;
  });

  it('does nothing (no fetch) when no endpoint is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await exportSpans(spans);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs OTLP to {endpoint}/v1/traces with configured headers', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example.com/';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer tok,x-tenant=acme';
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await exportSpans(spans);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://collector.example.com/v1/traces');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-tenant']).toBe('acme');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('never throws when the exporter fails', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example.com';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(exportSpans(spans)).resolves.toBeUndefined();
  });

  it('logs a JSON line when TRACE_LOG=true', async () => {
    process.env.TRACE_LOG = 'true';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await exportSpans(spans);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse((log.mock.calls[0] as unknown as [string])[0]);
    expect(line.type).toBe('trace');
    expect(line.spans[0].name).toBe('invoke_agent harness');
  });
});
