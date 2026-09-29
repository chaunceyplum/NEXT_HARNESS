import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyByRules, modelForTier, routeRequest } from './model-router';
import { ModelHealthTracker } from './model-health';
import type { ModelRegistryEntry } from './model-registry';
import { loadFixtures } from '@/evals/lib/fixtures';

const registry: ModelRegistryEntry[] = [
  { key: 'bedrock:cheap', label: '', provider: 'bedrock', modelId: 'h', tier: 'cheap' },
  { key: 'bedrock:balanced', label: '', provider: 'bedrock', modelId: 's', tier: 'balanced' },
  { key: 'bedrock:expensive', label: '', provider: 'bedrock', modelId: 'o', tier: 'expensive' },
  { key: 'anthropic:haiku', label: '', provider: 'anthropic', modelId: 'h', tier: 'cheap' },
];
const healthy = () => new ModelHealthTracker();

afterEach(() => {
  for (const k of ['DEFAULT_MODEL', 'ROUTE_TIERS', 'ROUTER_MIN_CONFIDENCE', 'ROUTER_CLARIFY']) delete process.env[k];
});

describe('classifyByRules', () => {
  it.each([
    ['What merge policies exist in the prod sandbox?', 'lookup'],
    ['List the Launch rules on property PR123', 'lookup'],
    ['How many profiles are in the CRM dataset?', 'lookup'],
    ['Create a segment for gold loyalty members', 'change'],
    ['Delete segment seg-201', 'change'],
    ['Set up a new schema and dataset and then create a streaming dataflow for it', 'build'],
    ['Implement the full web tagging plan from scratch', 'build'],
  ])('%s → %s', (request, category) => {
    expect(classifyByRules(request)?.category).toBe(category);
  });

  it('leaves ambiguous requests to the model', () => {
    expect(classifyByRules('segments')).toBeUndefined();
    expect(classifyByRules('Can you update the gold segment?')).toBeUndefined();
  });
});

describe('modelForTier', () => {
  it("stays on the default model's provider and skips unhealthy entries", () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    expect(modelForTier('cheap', registry, healthy())).toBe('bedrock:cheap');
    const sick = new ModelHealthTracker({ failureThreshold: 1 });
    sick.recordFailure('bedrock:cheap');
    // The only bedrock cheap entry is unhealthy: still returned (better than none); anthropic isn't crossed into.
    expect(modelForTier('cheap', registry, sick)).toBe('bedrock:cheap');
  });
});

describe('routeRequest', () => {
  it('routes clear lookups to the cheap tier by rules, without a model call', async () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    const classify = vi.fn();
    const r = await routeRequest('What datasets are profile-enabled?', { registry, health: healthy(), classify });
    expect(r).toMatchObject({ category: 'lookup', via: 'rules', tier: 'cheap', modelKey: 'bedrock:cheap' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('asks the model when rules cannot tell, and maps its category', async () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    const classify = vi.fn(async () => ({ category: 'build' as const, confidence: 0.9, reason: 'multi-step' }));
    const r = await routeRequest('Can you update the gold segment?', { registry, health: healthy(), classify });
    expect(classify).toHaveBeenCalledWith('Can you update the gold segment?', 'bedrock:cheap');
    expect(r).toMatchObject({ category: 'build', via: 'model', tier: 'expensive', modelKey: 'bedrock:expensive' });
  });

  it('falls back to the default model on low confidence instead of guessing', async () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    const classify = vi.fn(async () => ({ category: 'lookup' as const, confidence: 0.3, reason: 'maybe' }));
    const r = await routeRequest('segments', { registry, health: healthy(), classify });
    expect(r.modelKey).toBe('bedrock:balanced');
    expect(r.reason).toMatch(/low confidence/);
  });

  it('returns a clarifying question for unclear requests', async () => {
    const classify = vi.fn(async () => ({ category: 'unclear' as const, confidence: 0.8, reason: 'no object', clarifyingQuestion: 'Which segment do you mean?' }));
    const r = await routeRequest('the gold one from yesterday', { registry, health: healthy(), classify });
    expect(r).toMatchObject({ category: 'unclear', clarifyingQuestion: 'Which segment do you mean?' });
    process.env.ROUTER_CLARIFY = 'false';
    expect((await routeRequest('the gold one from yesterday', { registry, health: healthy(), classify })).clarifyingQuestion).toBeUndefined();
  });

  it('uses the default model when the router call fails', async () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    const classify = vi.fn(async () => {
      throw new Error('throttled');
    });
    const r = await routeRequest('segments', { registry, health: healthy(), classify });
    expect(r).toMatchObject({ via: 'fallback', modelKey: 'bedrock:balanced' });
  });

  it('honours ROUTE_TIERS overrides', async () => {
    process.env.DEFAULT_MODEL = 'bedrock:balanced';
    process.env.ROUTE_TIERS = '{"lookup":"balanced"}';
    const r = await routeRequest('What datasets exist?', { registry, health: healthy() });
    expect(r.modelKey).toBe('bedrock:balanced');
  });
});

describe('rules vs the labelled routing set (evals/fixtures/routing)', () => {
  const fixtures = loadFixtures<{ id: string; request: string; expected: string }>('routing');

  it.each(fixtures)('$id: rules never contradict the label', ({ request, expected }) => {
    const byRules = classifyByRules(request);
    // Undecided is fine (the router model takes it); a wrong confident call is not.
    if (byRules) expect(byRules.category).toBe(expected);
  });

  it('decides most clear cases without a model call', () => {
    const decided = fixtures.filter((f) => f.expected !== 'unclear' && classifyByRules(f.request));
    expect(decided.length / fixtures.filter((f) => f.expected !== 'unclear').length).toBeGreaterThanOrEqual(0.75);
  });
});
