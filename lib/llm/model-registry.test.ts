import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// model-registry caches its built registry in a module-level variable on
// first call, so each test that cares about env-driven differences needs a
// genuinely fresh module instance, not just another `import` of the
// already-cached one — vi.resetModules() forces that.
describe('model-registry', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('always includes the three Bedrock tiers, even with no env vars set', async () => {
    delete process.env.OPENAI_CHEAP_MODEL_ID;
    delete process.env.OPENAI_BALANCED_MODEL_ID;
    delete process.env.OPENAI_EXPENSIVE_MODEL_ID;
    const { getModelRegistry } = await import('./model-registry');
    const keys = getModelRegistry().map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['bedrock:cheap', 'bedrock:balanced', 'bedrock:expensive']));
  });

  it('always includes the three Anthropic-direct entries', async () => {
    const { getModelRegistry } = await import('./model-registry');
    const keys = getModelRegistry().map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['anthropic:haiku', 'anthropic:sonnet', 'anthropic:opus']));
  });

  it('only adds an OpenAI tier when its model id env var is set', async () => {
    delete process.env.OPENAI_CHEAP_MODEL_ID;
    process.env.OPENAI_BALANCED_MODEL_ID = 'gpt-4o';
    const { getModelRegistry } = await import('./model-registry');
    const keys = getModelRegistry().map((e) => e.key);
    expect(keys).not.toContain('openai:cheap');
    expect(keys).toContain('openai:balanced');
  });

  it('defaults to bedrock:balanced when DEFAULT_MODEL is unset', async () => {
    delete process.env.DEFAULT_MODEL;
    const { getDefaultModelKey } = await import('./model-registry');
    expect(getDefaultModelKey()).toBe('bedrock:balanced');
  });

  it('honors DEFAULT_MODEL when set', async () => {
    process.env.DEFAULT_MODEL = 'anthropic:sonnet';
    const { getDefaultModelKey } = await import('./model-registry');
    expect(getDefaultModelKey()).toBe('anthropic:sonnet');
  });

  it('throws a helpful error for an unknown model key', async () => {
    const { getModelEntry } = await import('./model-registry');
    expect(() => getModelEntry('not-a-real-key')).toThrow(/Unknown model key "not-a-real-key"/);
  });

  it('resolves a known key to a LanguageModel without throwing (no network call at construction time)', async () => {
    const { resolveModel } = await import('./model-registry');
    expect(() => resolveModel('anthropic:haiku')).not.toThrow();
    expect(() => resolveModel('bedrock:cheap')).not.toThrow();
  });
});
