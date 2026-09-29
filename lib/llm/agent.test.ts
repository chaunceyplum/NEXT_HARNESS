import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

// runAgent's live path end to end, against a scripted model and a fake
// catalog: approval gating (incl. via call_tool), dry-run, and the
// append-only loop on history-bound models.

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

type Scripted = { toolCall: { toolName: string; input: unknown } } | { text: string };
let script: Scripted[] = [];
// Every request the model received, as the SDK handed it to the provider.
let calls: Array<{ prompt: unknown[]; tools?: Array<{ name: string }>; toolChoice?: { type: string }; providerOptions?: Record<string, unknown> }> = [];
let executed: Array<{ name: string; input: unknown }> = [];

vi.mock('./model-registry', () => {
  const entries = [
    { key: 'test:bound', label: 'bound', provider: 'anthropic', modelId: 'claude-opus-5-5', tier: 'expensive' },
    { key: 'test:plain', label: 'plain', provider: 'anthropic', modelId: 'claude-sonnet-5', tier: 'balanced' },
  ];
  return {
    getModelRegistry: () => entries,
    getDefaultModelKey: () => 'test:plain',
    getModelEntry: (key: string) => {
      const e = entries.find((x) => x.key === key);
      if (!e) throw new Error(`unknown ${key}`);
      return e;
    },
    resolveModel: () =>
      // runAgent uses streamText, so doStream is the path exercised here.
      // doGenerate is kept for completeness/any other caller. Both consume
      // the same `script` queue and record the same `calls` for assertions.
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          calls.push(JSON.parse(JSON.stringify(options)));
          const next = script.shift() ?? { text: 'done' };
          if ('text' in next) {
            return { content: [{ type: 'text', text: next.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
          }
          return {
            content: [{ type: 'tool-call', toolCallId: `call-${calls.length}`, toolName: next.toolCall.toolName, input: JSON.stringify(next.toolCall.input) }],
            finishReason: { unified: 'tool-calls', raw: 'tool_use' },
            usage,
            warnings: [],
          };
        },
        doStream: async (options) => {
          calls.push(JSON.parse(JSON.stringify(options)));
          const next = script.shift() ?? { text: 'done' };
          const id = `call-${calls.length}`;
          const parts: LanguageModelV4StreamPart[] =
            'text' in next
              ? [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id },
                  { type: 'text-delta', id, delta: next.text },
                  { type: 'text-end', id },
                  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'tool-call', toolCallId: id, toolName: next.toolCall.toolName, input: JSON.stringify(next.toolCall.input) },
                  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
                ];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const p of parts) controller.enqueue(p);
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

const CATALOG = ['adobe_list_segments', 'adobe_delete_segment', 'adobe_create_segment', 'execute_sql', 'adobe_create_export_job'].map((name) => ({
  name,
  description: name.replace(/_/g, ' '),
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, sql: { type: 'string' } } },
}));

vi.mock('./tool-catalog', () => ({
  getMcpToolCatalog: async () => CATALOG,
  // runAgent creates a sink on the live path and drains it at the end; the
  // scripted tools here never judge, so an empty-draining stub is enough.
  createRagJudgmentSink: () => ({ track() {}, async drain() { return []; } }),
  buildAiTools: (defs: typeof CATALOG): ToolSet =>
    Object.fromEntries(
      defs.map((d) => [
        d.name,
        tool({
          description: d.description,
          inputSchema: jsonSchema(d.inputSchema as never),
          execute: async (input: unknown) => {
            executed.push({ name: d.name, input });
            // Big enough that client-side compression would rewrite it.
            return { ok: d.name, padding: 'x'.repeat(2_000) };
          },
        }),
      ])
    ),
}));

vi.mock('./tool-retrieval', () => ({ shortlistTools: async () => ['adobe_list_segments'] }));

const { runAgent } = await import('./agent');

beforeEach(() => {
  script = [];
  calls = [];
  executed = [];
  delete process.env.TOOL_DRY_RUN;
  delete process.env.BUILD_POLICY;
  delete process.env.RUN_MAX_TOKENS;
  delete process.env.ROLLOUT_MODE;
});

const deleteViaProxy: Scripted = {
  toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_delete_segment', arguments: { id: 's1' } } },
};

describe('runAgent approval gate', () => {
  it('asks before a destructive call routed through call_tool, and runs it when approved', async () => {
    script = [deleteViaProxy, { text: 'deleted' }];
    const approveTool = vi.fn(async () => ({ approved: true, reason: 'ok' }));

    await runAgent({ userInput: 'delete segment s1', modelKey: 'test:plain', approveTool });

    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'adobe_delete_segment', input: { id: 's1' } }));
    expect(executed).toEqual([{ name: 'adobe_delete_segment', input: { id: 's1' } }]);
  });

  it('does not execute a denied call, and records it in the trace', async () => {
    script = [deleteViaProxy, { text: 'ok, not deleted' }];

    const result = await runAgent({
      userInput: 'delete segment s1',
      modelKey: 'test:plain',
      approveTool: async () => ({ approved: false, reason: 'Denied by the user.' }),
    });

    expect(executed).toEqual([]);
    expect(result.steps[0].toolResults[0]).toMatchObject({ toolName: 'call_tool', error: 'Not executed: Denied by the user.' });
  });

  it('denies destructive calls when no approver is attached', async () => {
    script = [deleteViaProxy, { text: 'could not' }];
    await runAgent({ userInput: 'delete segment s1', modelKey: 'test:plain' });
    expect(executed).toEqual([]);
  });

  it('does not ask for approval of read or write calls', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_create_segment', arguments: { id: 'n' } } } }, { text: 'made' }];
    const approveTool = vi.fn();
    await runAgent({ userInput: 'create a segment', modelKey: 'test:plain', approveTool });
    expect(approveTool).not.toHaveBeenCalled();
    expect(executed.map((e) => e.name)).toEqual(['adobe_create_segment']);
  });

  it('asks before SQL that is not a single read-only query, with the reason', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'execute_sql', arguments: { sql: 'DROP TABLE harness_agent_runs' } } } }, { text: 'no' }];
    const approveTool = vi.fn(async () => ({ approved: false, reason: 'Denied by the user.' }));
    await runAgent({ userInput: 'clean up the runs table', modelKey: 'test:plain', approveTool });
    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'execute_sql', reason: 'sql-write' }));
    expect(executed).toEqual([]);
  });

  it('runs a read-only SELECT through execute_sql without asking', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'execute_sql', arguments: { sql: 'SELECT count(*) FROM runs' } } } }, { text: '3' }];
    const approveTool = vi.fn();
    await runAgent({ userInput: 'how many runs?', modelKey: 'test:plain', approveTool });
    expect(approveTool).not.toHaveBeenCalled();
    expect(executed.map((e) => e.name)).toEqual(['execute_sql']);
  });

  it('asks before an outbound call such as an export job', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_create_export_job', arguments: { id: 'x' } } } }, { text: 'no' }];
    const approveTool = vi.fn(async () => ({ approved: true, reason: 'ok' }));
    await runAgent({ userInput: 'export the audience', modelKey: 'test:plain', approveTool });
    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ reason: 'outbound' }));
  });

  it('asks before every write in assisted rollout mode', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_create_segment', arguments: { id: 'n' } } } }, { text: 'made' }];
    const approveTool = vi.fn(async () => ({ approved: true, reason: 'ok' }));
    await runAgent({ userInput: 'create a segment', modelKey: 'test:plain', rolloutMode: 'assisted', approveTool });
    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ reason: 'assisted-mode' }));
    expect(executed.map((e) => e.name)).toEqual(['adobe_create_segment']);
  });

  it('dry-runs writes in shadow rollout mode, and a request cannot loosen ROLLOUT_MODE', async () => {
    process.env.ROLLOUT_MODE = 'shadow';
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_create_segment', arguments: { id: 'n' } } } }, { text: 'shadow' }];
    const approveTool = vi.fn();
    const result = await runAgent({ userInput: 'create a segment', modelKey: 'test:plain', rolloutMode: 'autonomous', approveTool });
    expect(approveTool).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(result.steps[0].toolResults[0].output).toMatchObject({ _dryRun: true });
  });

  it('skips approval in dry-run mode, where destructive tools do not execute', async () => {
    script = [deleteViaProxy, { text: 'dry run' }];
    const approveTool = vi.fn();
    const result = await runAgent({ userInput: 'delete segment s1', modelKey: 'test:plain', dryRun: true, approveTool });
    expect(approveTool).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(result.steps[0].toolResults[0].output).toMatchObject({ _dryRun: true });
  });

  it('refuses call_tool for a tool the read-only policy removed', async () => {
    script = [{ toolCall: { toolName: 'call_tool', input: { tool_name: 'adobe_create_segment', arguments: {} } } }, { text: 'blocked' }];
    const result = await runAgent({ userInput: 'create a segment', modelKey: 'test:plain', policy: 'read-only' });
    expect(executed).toEqual([]);
    expect(result.steps[0].toolResults[0].error).toMatch(/not available on this run/);
  });
});

describe('runAgent loop shape', () => {
  const listCall: Scripted = { toolCall: { toolName: 'adobe_list_segments', input: {} } };
  const toolNames = (c: (typeof calls)[number]) => (c.tools ?? []).map((t) => t.name);

  it('keeps the tool list fixed for the whole run', async () => {
    script = [{ toolCall: { toolName: 'find_tools', input: { query: 'delete segment' } } }, { text: 'found it' }];
    await runAgent({ userInput: 'list segments', modelKey: 'test:plain', maxSteps: 5 });
    expect(calls.length).toBe(2);
    expect(toolNames(calls[1])).toEqual(toolNames(calls[0]));
    expect(toolNames(calls[0])).toEqual(expect.arrayContaining(['adobe_list_segments', 'find_tools', 'call_tool', 'policy_info']));
    expect(toolNames(calls[0])).not.toContain('adobe_delete_segment');
  });

  it('on a history-bound model, never rewrites earlier messages or drops tools, and uses server-side context editing', async () => {
    script = [listCall, listCall, listCall, { text: 'final' }];
    await runAgent({ userInput: 'list segments three times', modelKey: 'test:bound', maxSteps: 4 });

    expect(calls.length).toBe(4);
    for (let i = 1; i < calls.length; i++) {
      // Each request's history is the previous request's, plus appended messages.
      expect(calls[i].prompt.slice(0, calls[i - 1].prompt.length)).toEqual(calls[i - 1].prompt);
      expect(toolNames(calls[i])).toEqual(toolNames(calls[0]));
      expect(calls[i].toolChoice?.type).not.toBe('none');
    }
    expect(JSON.stringify(calls.at(-1)!.prompt.at(-1))).toContain('This is your last step');
    expect(calls[0].providerOptions?.anthropic).toMatchObject({
      contextManagement: { edits: [expect.objectContaining({ type: 'clear_tool_uses_20250919' })] },
    });
  });

  it('on other models, compresses old tool results and forces text on the last step', async () => {
    script = [listCall, listCall, listCall, { text: 'final' }];
    await runAgent({ userInput: 'list segments three times', modelKey: 'test:plain', maxSteps: 4 });

    const last = calls.at(-1)!;
    expect(last.toolChoice?.type).toBe('none');
    expect(JSON.stringify(last.prompt)).toContain('[compressed to save context]');
    expect(calls[0].providerOptions?.anthropic).toBeUndefined();
  });
});

describe('runAgent run budgets', () => {
  const listSame: Scripted = { toolCall: { toolName: 'adobe_list_segments', input: { id: 'same' } } };
  const lastPromptText = () => JSON.stringify(calls[calls.length - 1].prompt);

  it('warns the model about a repeated identical call, then stops the loop and asks for a wrap-up', async () => {
    // The mock model ignores toolChoice, so the script itself answers on the wrap-up step.
    script = [listSame, listSame, listSame, listSame, { text: 'wrapped up' }];
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:plain' });

    // Step 4's prompt carries the warning; step 5 is the forced wrap-up.
    expect(JSON.stringify(calls[3].prompt)).toContain('3 times with identical arguments');
    expect(calls[4].toolChoice).toEqual({ type: 'none' });
    expect(lastPromptText()).toContain('kept repeating the same tool call');
    expect(result.stopReason).toBe('loop-detected');
    expect(executed).toHaveLength(4);
    expect(calls).toHaveLength(5);
  });

  it('stops at the token budget with a partial-result flag instead of failing', async () => {
    script = [listSame, { toolCall: { toolName: 'adobe_list_segments', input: { id: 'b' } } }, listSame, { text: 'partial' }];
    // Each scripted step reports 15 tokens.
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:plain', budget: { maxTokens: 20 } });

    expect(result.stopReason).toBe('token-budget');
    expect(calls).toHaveLength(3);
    expect(calls[2].toolChoice).toEqual({ type: 'none' });
    expect(lastPromptText()).toContain('token budget');
    expect(result.budgetUsage.tokens).toBe(45);
  });

  it('on a history-bound model, keeps the tools array and appends the wrap-up note', async () => {
    script = [listSame, listSame, { text: 'partial' }];
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:bound', budget: { maxTokens: 20 } });
    expect(result.stopReason).toBe('token-budget');
    expect(calls[2].tools?.length).toBeGreaterThan(0);
    expect(lastPromptText()).toContain('token budget');
  });

  it('leaves a run inside its limits alone', async () => {
    script = [listSame, { text: 'done' }];
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:plain' });
    expect(result.stopReason).toBeUndefined();
    expect(result.finalText).toBe('done');
  });
});

describe('runAgent token streaming (TASK 1)', () => {
  it('forwards assistant text deltas via onTextDelta as the model generates them', async () => {
    script = [{ toolCall: { toolName: 'adobe_list_segments', input: {} } }, { text: 'here is the answer' }];
    const deltas: string[] = [];

    const result = await runAgent({
      userInput: 'list segments',
      modelKey: 'test:plain',
      maxSteps: 3,
      onTextDelta: (d) => deltas.push(d),
    });

    // The streamed chunks reassemble into the final answer text.
    expect(deltas.join('')).toContain('here is the answer');
    expect(result.finalText).toBe('here is the answer');
  });
});

describe('runAgent plan-first', () => {
  const plan = {
    goal: 'List segments',
    steps: [
      { id: 1, description: 'List the segments', tool: 'adobe_list_segments', expectedOutput: 'segment names', dependsOn: [] },
      { id: 2, description: 'Answer', tool: null, expectedOutput: 'the list', dependsOn: [1] },
    ],
  };

  it('plans, gives the executor the plan and the plan tools, and returns the tracked plan', async () => {
    script = [
      { text: JSON.stringify(plan) },
      { toolCall: { toolName: 'update_plan', input: { stepId: 1, status: 'done', note: '2 segments' } } },
      { text: 'There are 2 segments.' },
    ];
    const updates: unknown[] = [];
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:plain', planFirst: true, onPlan: (p) => updates.push(JSON.parse(JSON.stringify(p))) });

    const executorPrompt = JSON.stringify(calls[1].prompt);
    expect(executorPrompt).toContain('Execute this plan');
    expect(executorPrompt).toContain('1. [pending] List the segments');
    expect(calls[1].tools?.map((t) => t.name)).toEqual(expect.arrayContaining(['update_plan', 'revise_plan']));
    expect(result.plan?.steps[0]).toMatchObject({ status: 'done', note: '2 segments' });
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it('runs nothing when the plan is denied', async () => {
    script = [{ text: JSON.stringify(plan) }];
    const result = await runAgent({
      userInput: 'list segments',
      modelKey: 'test:plain',
      planFirst: true,
      approvePlan: async () => ({ approved: false, reason: 'Denied by "bob".' }),
    });
    expect(result.finalText).toMatch(/plan wasn't approved/);
    expect(calls).toHaveLength(1);
    expect(executed).toEqual([]);
  });

  it('falls back to running without a plan when planning fails', async () => {
    script = [{ text: 'not json' }, { text: 'done anyway' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runAgent({ userInput: 'list segments', modelKey: 'test:plain', planFirst: true });
    warn.mockRestore();
    expect(result.plan).toBeUndefined();
    expect(result.finalText).toBe('done anyway');
  });
});

describe('runAgent with model "auto"', () => {
  it('routes a clear change request by rules and records the decision, without pinning', async () => {
    script = [{ text: 'done' }];
    const routes: unknown[] = [];
    const result = await runAgent({ userInput: 'Create a segment for gold members', modelKey: 'auto', onRoute: (r) => routes.push(r) });
    expect(result.route).toMatchObject({ category: 'change', via: 'rules', tier: 'balanced', modelKey: 'test:plain' });
    expect(routes).toHaveLength(1);
    expect(result.modelKey).toBe('test:plain');
  });
});

describe('runAgent tool outcomes (audit log feed)', () => {
  it('reports each call with its effective tool, level, outcome and approval reason', async () => {
    script = [
      { toolCall: { toolName: 'adobe_list_segments', input: {} } },
      deleteViaProxy,
      { text: 'done' },
    ];
    const outcomes: unknown[] = [];
    await runAgent({
      userInput: 'delete segment s1',
      modelKey: 'test:plain',
      approveTool: async () => ({ approved: false, reason: 'Denied by "bob".' }),
      onToolOutcome: (o) => outcomes.push(o),
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ toolName: 'adobe_list_segments', level: 'read', outcome: 'ok' }),
      expect.objectContaining({
        toolName: 'adobe_delete_segment',
        input: { id: 's1' },
        level: 'destructive',
        outcome: 'denied',
        approvalReason: 'destructive',
        error: 'Denied by "bob".',
      }),
    ]);
  });
});

describe('runAgent plan-first with model "auto"', () => {
  it('plans on the routed model rather than the literal "auto"', async () => {
    const plan = { goal: 'g', steps: [{ id: 1, description: 'Answer', tool: null, expectedOutput: 'x', dependsOn: [] }] };
    script = [{ text: JSON.stringify(plan) }, { text: 'done' }];
    const result = await runAgent({ userInput: 'Create a segment for gold members', modelKey: 'auto', planFirst: true });
    expect(result.route?.modelKey).toBe('test:plain');
    expect(result.plan?.goal).toBe('g');
  });
});
