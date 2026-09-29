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

vi.mock('@/lib/llm/model-registry', async (orig) => ({
  ...(await orig<typeof import('@/lib/llm/model-registry')>()),
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

const { judge, JudgeError } = await import('./judge');
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
