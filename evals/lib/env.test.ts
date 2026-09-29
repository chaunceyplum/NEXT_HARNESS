import { afterEach, describe, expect, it } from 'vitest';
import { isModelConfigured, isPlaceholder, judgeModelKey, modelSource } from './env';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('isPlaceholder', () => {
  it('recognizes unfilled .env.local.example values', () => {
    for (const v of ['...', 'sk-ant-...', '<api-gateway-key>', 'your-key', 'changeme']) expect(isPlaceholder(v)).toBe(true);
    for (const v of ['AKIAABCDEFGH', 'sk-ant-api03-abc', undefined]) expect(isPlaceholder(v)).toBe(false);
  });
});

describe('isModelConfigured', () => {
  it('treats a placeholder API key as unconfigured', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-...';
    expect(isModelConfigured('anthropic:sonnet')).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-real';
    expect(isModelConfigured('anthropic:sonnet')).toBe(true);
  });

  it('counts Bedrock as configured with no keys at all (instance role / default chain), but not with placeholder keys', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(isModelConfigured('bedrock:balanced')).toBe(true);
    process.env.AWS_ACCESS_KEY_ID = '...';
    expect(isModelConfigured('bedrock:balanced')).toBe(false);
  });

  it('rejects unknown model keys', () => {
    expect(isModelConfigured('nope:nope')).toBe(false);
  });
});

describe('judgeModelKey / modelSource', () => {
  it('defaults the judge to the strongest tier of the default provider', () => {
    delete process.env.EVAL_JUDGE_MODEL;
    process.env.DEFAULT_MODEL = 'anthropic:sonnet';
    expect(judgeModelKey()).toBe('anthropic:opus-5-5');
    expect(modelSource('judge')).toMatch(/strongest tier of DEFAULT_MODEL/);
  });

  it('says when DEFAULT_MODEL is unset, which is how Bedrock gets picked silently', () => {
    delete process.env.DEFAULT_MODEL;
    delete process.env.EVAL_MODEL;
    expect(modelSource('model')).toMatch(/DEFAULT_MODEL unset/);
  });
});
