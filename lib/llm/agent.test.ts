import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool, jsonSchema, type ToolSet } from 'ai';

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
