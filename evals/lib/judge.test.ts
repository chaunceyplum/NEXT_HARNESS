import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const verdictJson = JSON.stringify({
  scores: [{ criterion: 1, score: 5, evidence: 'q' }],
  verdict: 'pass',
  reasoning: 'ok',
});

// Per-model behavior, keyed by registry key: "refuse" mimics an Anthropic
// stop_reason "refusal" (finish reason content-filter, no content).
const behavior: Record<string, 'refuse' | 'ok' | 'throw'> = {};

vi.mock('@/lib/llm/models/model-registry', async (orig) => ({
  ...(await orig<typeof import('@/lib/llm/models/model-registry')>()),
  resolveModel: (key: string) =>
    new MockLanguageModelV4({
      doGenerate: async () => {
        if (behavior[key] === 'throw') throw new Error('overloaded');
        return behavior[key] === 'refuse'
          ? { content: [], finishReason: { unified: 'content-filter', raw: 'refusal' }, usage, warnings: [] }
          : { content: [{ type: 'text', text: verdictJson }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
      },
    }),
}));

const { judge, JudgeError, summarizeToolActivity } = await import('./judge');
const input = { task: 't', criteria: ['c'], answer: 'a' };

describe('judge refusal handling', () => {
  it('falls back when the primary judge refuses, and says so', async () => {
    behavior.primary = 'refuse';
    behavior.backup = 'ok';
    const r = await judge('primary', input, 'backup');
    expect(r.pass).toBe(true);
    expect(r.judgedBy).toBe('backup');
    expect(r.fallbackReason).toMatch(/refused.*content-filter/);
  });

  it('throws a JudgeError naming the refusal when there is no fallback', async () => {
    behavior.primary = 'refuse';
    await expect(judge('primary', input)).rejects.toThrow(JudgeError);
    await expect(judge('primary', input)).rejects.toThrow(/refused to grade/);
  });

  it('does not fall back on a non-refusal failure', async () => {
    behavior.primary = 'throw';
    behavior.backup = 'ok';
    await expect(judge('primary', input, 'backup')).rejects.toThrow(/primary call failed: overloaded/);
  });
});

describe('summarizeToolActivity', () => {
  const schemaList = { results: Array.from({ length: 60 }, (_, i) => ({ $id: `https://ns.adobe.com/acme/schemas/s${i}`, title: `Schema ${i}`, properties: { x: 'p'.repeat(600) } })) };
  const step = (toolName: string, input: unknown, output: unknown, error?: string) => ({
    toolCalls: [{ toolName, input }],
    toolResults: [{ toolName, output, ...(error ? { error } : {}) }],
  });

  it('keeps every id of a large list result instead of an 800-char slice', () => {
    const text = summarizeToolActivity([step('adobe_list_schemas', {}, schemaList)]);
    expect(text).toContain('https://ns.adobe.com/acme/schemas/s0');
    expect(text).toContain('https://ns.adobe.com/acme/schemas/s59');
    // The rendered result is valid JSON.
    const json = text.split('\n').find((l) => l.startsWith('RESULT'))!.replace(/^RESULT adobe_list_schemas: /, '');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('keeps the last steps (the writes) when the run is long, shrinking reads first', () => {
    const reads = Array.from({ length: 40 }, (_, i) => step('adobe_list_schemas', { page: i }, schemaList));
    const write = step('adobe_create_field_group', { title: 'Attribution' }, { $id: 'fg-final', title: 'Attribution' });
    const text = summarizeToolActivity([...reads, write]);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text).toContain('CALL adobe_create_field_group');
    expect(text).toContain('fg-final');
    // Every call line survives, even where a read's body was dropped.
    expect(text.match(/^CALL adobe_list_schemas/gm)).toHaveLength(40);
  });

  it('keeps error text and pairs call_tool calls with their target for read/write sizing', () => {
    const text = summarizeToolActivity([
      step('call_tool', { tool_name: 'adobe_update_segment', arguments: { id: 'seg-1' } }, undefined, '422: field "expression" invalid'),
    ]);
    expect(text).toContain('CALL call_tool');
    expect(text).toContain('ERROR call_tool: 422: field "expression" invalid');
  });

  it('honours JUDGE_ACTIVITY_MAX_CHARS', () => {
    process.env.JUDGE_ACTIVITY_MAX_CHARS = '5000';
    try {
      const reads = Array.from({ length: 10 }, (_, i) => step('adobe_list_schemas', { page: i }, schemaList));
      expect(summarizeToolActivity(reads).length).toBeLessThanOrEqual(5_000);
    } finally {
      delete process.env.JUDGE_ACTIVITY_MAX_CHARS;
    }
  });
});
