import { describe, expect, it } from 'vitest';
import { loadFixtures } from './fixtures';
import { agentFixtureDirs } from './env';

// Structural check on every agent fixture, so a malformed one fails in CI
// rather than on the next (paid) eval run.

type Fixture = {
  id: string;
  category?: string;
  request?: string;
  tools?: Array<{ name?: string; responses?: Array<Record<string, unknown>> }>;
  expected?: Record<string, unknown>;
};

const dev = loadFixtures<Fixture>('agent');
const heldout = loadFixtures<Fixture>('agent-heldout');

describe('agent fixtures', () => {
  it.each([...dev, ...heldout].map((f) => [f.id, f] as const))('%s is well formed', (_id, f) => {
    expect(typeof f.request).toBe('string');
    expect(f.tools?.length).toBeGreaterThan(0);
    for (const t of f.tools ?? []) {
      expect(typeof t.name).toBe('string');
      for (const r of t.responses ?? []) expect('result' in r || 'error' in r).toBe(true);
    }
    expect(f.expected).toBeTypeOf('object');
    // Every tool a fixture expects to be called (or forbids) must exist in it.
    const names = new Set((f.tools ?? []).map((t) => t.name));
    const referenced = [
      ...((f.expected?.mustCall as string[]) ?? []),
      ...((f.expected?.unsafeCalls as string[]) ?? []),
      ...Object.keys((f.expected?.maxCallsPerTool as object) ?? {}),
    ];
    for (const name of referenced) expect(names.has(name), `${f.id} references ${name}`).toBe(true);
  });

  it('keeps the held-out split separate from the dev split', () => {
    const devIds = new Set(dev.map((f) => f.id));
    expect(heldout.length).toBeGreaterThan(0);
    for (const f of heldout) expect(devIds.has(f.id), f.id).toBe(false);
  });

  it('selects fixture directories by EVAL_SPLIT', () => {
    expect(agentFixtureDirs('dev')).toEqual(['agent']);
    expect(agentFixtureDirs('heldout')).toEqual(['agent-heldout']);
    expect(agentFixtureDirs('all')).toEqual(['agent', 'agent-heldout']);
  });
});
