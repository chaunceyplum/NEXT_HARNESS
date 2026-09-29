import { afterEach, describe, expect, it, vi } from 'vitest';

const verdicts: unknown[] = [];
const revisions: string[] = [];
const prompts: string[] = [];

vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateObject: vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    const next = verdicts.shift();
    if (next instanceof Error) throw next;
    return { object: next };
  }),
  generateText: vi.fn(async () => ({ text: revisions.shift() ?? '' })),
}));
vi.mock('./model-registry', () => ({ resolveModel: () => ({}) }));

const { critiqueAnswer } = await import('./answer-critic');

const steps = [
  {
    stepNumber: 0,
    text: '',
    toolCalls: [{ toolName: 'adobe_create_segment', input: { name: 'Gold' } }],
    toolResults: [{ toolName: 'adobe_create_segment', output: undefined, error: 'HTTP 422: invalid expression' }],
  },
];
const ok = { grounded: true, answersRequest: true, unsupportedClaims: [], issues: [] };
const bad = { grounded: false, answersRequest: true, unsupportedClaims: ['the segment was created'], issues: ['The create call failed with 422.'] };

afterEach(() => {
  verdicts.length = 0;
  revisions.length = 0;
  prompts.length = 0;
  delete process.env.CRITIC_MODE;
});

describe('critiqueAnswer', () => {
  it('passes a grounded answer through unchanged, showing the critic the tool activity', async () => {
    verdicts.push(ok);
    const r = await critiqueAnswer({ task: 'create Gold', answer: 'Creation failed with a 422.', steps, modelKey: 'm' });
    expect(r).toMatchObject({ answer: 'Creation failed with a 422.', critique: { passed: true, revised: false } });
    expect(prompts[0]).toContain('ERROR adobe_create_segment: HTTP 422');
  });

  it('in flag mode (default), flags an unsupported claim without rewriting', async () => {
    verdicts.push(bad);
    const r = await critiqueAnswer({ task: 'create Gold', answer: 'Created the Gold segment.', steps, modelKey: 'm' });
    expect(r).toMatchObject({ answer: 'Created the Gold segment.', critique: { passed: false, revised: false, unsupportedClaims: ['the segment was created'] } });
  });

  it('in revise mode, rewrites once and re-checks', async () => {
    verdicts.push(bad, ok);
    revisions.push('The create call failed (422: invalid expression), so no segment was created.');
    const r = await critiqueAnswer({ task: 'create Gold', answer: 'Created the Gold segment.', steps, modelKey: 'm', mode: 'revise' });
    expect(r?.answer).toMatch(/failed/);
    expect(r?.critique).toMatchObject({ passed: true, revised: true, originalAnswer: 'Created the Gold segment.' });
  });

  it('returns the revision flagged when it still fails — no second revision', async () => {
    verdicts.push(bad, bad);
    revisions.push('Still wrong.', 'Should never be used.');
    const r = await critiqueAnswer({ task: 'create Gold', answer: 'Created it.', steps, modelKey: 'm', mode: 'revise' });
    expect(r).toMatchObject({ answer: 'Still wrong.', critique: { passed: false, revised: true } });
    expect(revisions).toEqual(['Should never be used.']);
  });

  it('skips when off, when no tools ran, and when the critic fails', async () => {
    expect(await critiqueAnswer({ task: 't', answer: 'a', steps, modelKey: 'm', mode: 'off' })).toBeUndefined();
    expect(await critiqueAnswer({ task: 't', answer: 'a', steps: [{ stepNumber: 0, text: 'hi', toolCalls: [], toolResults: [] }], modelKey: 'm' })).toBeUndefined();
    verdicts.push(new Error('throttled'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await critiqueAnswer({ task: 't', answer: 'a', steps, modelKey: 'm' })).toBeUndefined();
    spy.mockRestore();
  });
});
