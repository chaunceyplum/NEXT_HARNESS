import { describe, expect, it } from 'vitest';
import { buildScriptedTools } from './scripted-tools';

/** Invoke a scripted tool's execute() the way the AI SDK would. */
async function call(tools: ReturnType<typeof buildScriptedTools>['tools'], name: string, input: unknown): Promise<unknown> {
  const execute = tools[name].execute as (input: unknown, opts: unknown) => Promise<unknown>;
  return execute(input, {});
}

describe('buildScriptedTools (Requirement 16.1: answer by name + input, order-independent)', () => {
  it('selects a response by its `when` matcher regardless of call order', async () => {
    const { tools } = buildScriptedTools([
      {
        name: 'get_thing',
        description: 'x',
        responses: [
          { when: { id: 'A' }, result: { value: 'alpha' } },
          { when: { id: 'B' }, result: { value: 'beta' } },
        ],
      },
    ]);
    // B before A, then A again: each input gets its own answer every time.
    expect(await call(tools, 'get_thing', { id: 'B' })).toEqual({ value: 'beta' });
    expect(await call(tools, 'get_thing', { id: 'A' })).toEqual({ value: 'alpha' });
    expect(await call(tools, 'get_thing', { id: 'A' })).toEqual({ value: 'alpha' });
  });

  it('matches a stringified-JSON value nested in the input (model varies the shape)', async () => {
    const { tools } = buildScriptedTools([
      {
        name: 'create_component',
        description: 'x',
        responses: [{ when: { delegate: 'core::events::click' }, result: { id: 'RC1' } }],
      },
    ]);
    expect(await call(tools, 'create_component', { delegate: 'core::events::click', name: 'Click' })).toEqual({ id: 'RC1' });
    // A value the matcher doesn't cover falls back to the default ok response.
    expect(await call(tools, 'create_component', { delegate: 'core::events::other' })).toEqual({ ok: true });
  });

  it('throws when the matched response is an error', async () => {
    const { tools } = buildScriptedTools([
      { name: 'flaky', description: 'x', responses: [{ when: { id: 'bad' }, error: 'boom' }] },
    ]);
    await expect(call(tools, 'flaky', { id: 'bad' })).rejects.toThrow('boom');
  });

  it('still consumes unmatched responses in queue order, repeating the last (back-compat)', async () => {
    const { tools, calls } = buildScriptedTools([
      { name: 'seq', description: 'x', responses: [{ result: { n: 1 } }, { result: { n: 2 } }] },
    ]);
    expect(await call(tools, 'seq', {})).toEqual({ n: 1 });
    expect(await call(tools, 'seq', {})).toEqual({ n: 2 });
    expect(await call(tools, 'seq', {})).toEqual({ n: 2 });
    expect(calls).toHaveLength(3);
  });

  it('prefers a matcher over the queue, so a per-worker call is stable while others advance the queue', async () => {
    const { tools } = buildScriptedTools([
      {
        name: 'mixed',
        description: 'x',
        responses: [{ result: { n: 1 } }, { when: { pin: 'yes' }, result: { pinned: true } }, { result: { n: 2 } }],
      },
    ]);
    expect(await call(tools, 'mixed', { pin: 'yes' })).toEqual({ pinned: true });
    expect(await call(tools, 'mixed', {})).toEqual({ n: 1 });
    expect(await call(tools, 'mixed', { pin: 'yes' })).toEqual({ pinned: true });
    expect(await call(tools, 'mixed', {})).toEqual({ n: 2 });
  });
});
