import { afterEach, describe, expect, it } from 'vitest';
import { JUDGEABLE_RAG_TOOLS, judgeRagResult, shouldJudgeLiveResult } from './rag-judge';

describe('JUDGEABLE_RAG_TOOLS', () => {
  it('covers the semantic-search tools, not the raw-SQL or health-check ones', () => {
    expect(JUDGEABLE_RAG_TOOLS.has('search_adobe_knowledge')).toBe(true);
    expect(JUDGEABLE_RAG_TOOLS.has('search_all_agents')).toBe(true);
    expect(JUDGEABLE_RAG_TOOLS.has('query_rag_db')).toBe(false);
    expect(JUDGEABLE_RAG_TOOLS.has('knowledge_base_health')).toBe(false);
  });
});

describe('judgeRagResult', () => {
  const originalEnabled = process.env.RAG_JUDGE_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.RAG_JUDGE_ENABLED;
    else process.env.RAG_JUDGE_ENABLED = originalEnabled;
  });

  it('short-circuits to undefined without making a model call when disabled', async () => {
    process.env.RAG_JUDGE_ENABLED = 'false';
    // If this ever tried to call a real model, it would throw (no live
    // credentials in a test environment) instead of resolving cleanly.
    await expect(judgeRagResult('what is a merge policy?', { results: ['irrelevant'] })).resolves.toBeUndefined();
  });
});

describe('shouldJudgeLiveResult', () => {
  const original = process.env.RAG_JUDGE_SAMPLE_RATE;
  afterEach(() => {
    if (original === undefined) delete process.env.RAG_JUDGE_SAMPLE_RATE;
    else process.env.RAG_JUDGE_SAMPLE_RATE = original;
  });

  it('samples 10% by default', () => {
    delete process.env.RAG_JUDGE_SAMPLE_RATE;
    expect(shouldJudgeLiveResult({ results: ['a'] }, () => 0.05)).toBe(true);
    expect(shouldJudgeLiveResult({ results: ['a'] }, () => 0.5)).toBe(false);
  });

  it('skips empty results regardless of rate', () => {
    process.env.RAG_JUDGE_SAMPLE_RATE = '1';
    for (const empty of [null, '', [], {}, { results: [] }]) {
      expect(shouldJudgeLiveResult(empty, () => 0)).toBe(false);
    }
  });
});
