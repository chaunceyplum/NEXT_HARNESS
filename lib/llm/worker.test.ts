import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { PlanStep } from './planner';

// runWorker end to end against a scripted model + scripted tools: tool
// narrowing (4.2/4.3), forced report_result on the last step (4.6), the
// missing-result failure (4.7), and the per-worker fallback rules (10.1/10.2).

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

type Scripted =
  | { toolCall: { toolName: string; input: unknown } }
  | { text: string }
  | { throw: string };
let script: Scripted[] = [];
let calls: Array<{ toolChoice?: { type: string; toolName?: string }; tools?: Array<{ name: string }> }> = [];
let executed: Array<{ name: string; input: unknown }> = [];

vi.mock('./model-registry', () => {
  // Two balanced-tier siblings so pickFallback has a same-tier target.
  const entries = [
    { key: 'test:a', label: 'a', provider: 'anthropic', modelId: 'claude-sonnet-5', tier: 'balanced' },
    { key: 'test:b', label: 'b', provider: 'anthropic', modelId: 'claude-sonnet-5-alt', tier: 'balanced' },
  ];
  return {
    getModelRegistry: () => entries,
    getDefaultModelKey: () => 'test:a',
    getModelEntry: (key: string) => {
      const e = entries.find((x) => x.key === key);
      if (!e) throw new Error(`unknown ${key}`);
      return e;
    },
    resolveModel: () =>
      new MockLanguageModelV4({
        doStream: async (options) => {
          calls.push(JSON.parse(JSON.stringify(options)));
          const next = script.shift() ?? { text: 'done' };
          const id = `call-${calls.length}`;
          if ('throw' in next) {
            // A provider failure surfaced through the stream (not a thrown
            // doStream, which the SDK would silently retry): it rejects
            // stream.text/steps and so reaches executeLoop's fallback catch.
            const err = new Error(next.throw);
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: 'stream-start', warnings: [] });
                  controller.error(err);
                },
              }),
            };
          }
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

const { runWorker, workerTools, reportResultTool, buildWorkerBrief, serialiseWrites, WriteLock, MAX_SUMMARY_CHARS, MAX_NOTES_CHARS } = await import('./worker');
const { ModelHealthTracker } = await import('./model-health');
const { RunLedger, resolveBudget } = await import('./run-budget');
const { LaunchValidationGate } = await import('./launch-validation');

/** A scripted, policy-allowed tool set the way a run hands one to a worker. */
function makeToolSet(names: string[]): ToolSet {
  return Object.fromEntries(
    names.map((name) => [
      name,
      tool({
        description: name.replace(/_/g, ' '),
        inputSchema: jsonSchema<{ id?: string }>({ type: 'object', properties: { id: { type: 'string' } } }),
        execute: async (input: unknown) => {
          executed.push({ name, input });
          return { ok: name };
        },
      }),
    ])
  );
}

function makeStep(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 2,
    description: 'Create the data element',
    tool: 'reactor_create_data_element',
    expectedOutput: 'the new data element id',
    dependsOn: [1],
    status: 'pending',
    ...over,
  };
}

function makeShared(over: Partial<Parameters<typeof runWorker>[0]['shared']> = {}) {
  return {
    runId: 'run1',
    ledger: new RunLedger(resolveBudget(), 0, () => 0),
    modelHealth: new ModelHealthTracker(),
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof runWorker>[0]> = {}): Parameters<typeof runWorker>[0] {
  return {
    runGoal: 'Build the tags',
    step: makeStep(),
    deps: [],
    tools: makeToolSet(['reactor_create_data_element', 'reactor_list_rules', 'adobe_list_segments']),
    catalog: [
      { name: 'reactor_create_data_element', description: '', inputSchema: { type: 'object' } },
      { name: 'reactor_list_rules', description: '', inputSchema: { type: 'object' } },
      { name: 'adobe_list_segments', description: '', inputSchema: { type: 'object' } },
    ],
    modelKey: 'test:a',
    maxSteps: 3,
    shared: makeShared(),
    attempt: 1,
    ...over,
  };
}

beforeEach(() => {
  script = [];
  calls = [];
  executed = [];
});

const report = (input: Record<string, unknown>): Scripted => ({
  toolCall: { toolName: 'report_result', input },
});

/** A catalog (names only, as workerTools reads) for the given MCP tool names. */
function makeCatalog(names: string[]) {
  return names.map((name) => ({ name, description: name, inputSchema: { type: 'object' as const } }));
}

describe('workerTools', () => {
  it('keeps the step tool, its platform-group siblings, and discovery tools', () => {
    const all = makeToolSet(['reactor_create_data_element', 'reactor_list_rules', 'adobe_list_segments', 'find_tools', 'call_tool']);
    const catalog = makeCatalog(['reactor_create_data_element', 'reactor_list_rules', 'adobe_list_segments']);
    const tools = workerTools(all, makeStep({ tool: 'reactor_create_data_element' }), catalog);
    // reactor_* siblings are kept; the AEP adobe_ tool (different group) is dropped.
    expect(Object.keys(tools).sort()).toEqual(['call_tool', 'find_tools', 'reactor_create_data_element', 'reactor_list_rules']);
  });

  it('never includes remember_fact, update_plan or revise_plan (Req 4.3)', () => {
    const all = makeToolSet(['reactor_create_data_element', 'remember_fact', 'update_plan', 'revise_plan', 'find_tools']);
    const catalog = makeCatalog(['reactor_create_data_element']);
    const tools = workerTools(all, makeStep(), catalog);
    expect(tools).not.toHaveProperty('remember_fact');
    expect(tools).not.toHaveProperty('update_plan');
    expect(tools).not.toHaveProperty('revise_plan');
  });

  it('still offers discovery tools when the step tool is null', () => {
    const all = makeToolSet(['reactor_create_data_element', 'find_tools', 'call_tool']);
    const tools = workerTools(all, makeStep({ tool: null }), makeCatalog(['reactor_create_data_element']));
    expect(Object.keys(tools).sort()).toEqual(['call_tool', 'find_tools']);
  });
});

describe('serialiseWrites (Req 3.4)', () => {
  it('runs write calls one at a time, including writes through call_tool, and leaves reads alone', async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const slow = (name: string) =>
      tool({
        description: name,
        inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
        execute: (_input: unknown) =>
          new Promise((resolve) => {
            log.push(`start ${name}`);
            gates.set(name, () => {
              log.push(`end ${name}`);
              resolve({ ok: name });
            });
          }),
      });
    const tools = serialiseWrites(
      { reactor_create_rule: slow('reactor_create_rule'), call_tool: slow('call_tool'), reactor_list_rules: slow('reactor_list_rules') },
      new WriteLock()
    );
    const opts = { toolCallId: 'c', messages: [] } as never;
    const tick = () => new Promise((r) => setTimeout(r, 0));

    const a = tools.reactor_create_rule.execute!({}, opts);
    const b = tools.call_tool.execute!({ tool_name: 'reactor_create_data_element', arguments: {} }, opts);
    const c = tools.reactor_list_rules.execute!({}, opts);
    await tick();
    // The direct write and the read started; the proxied write waits its turn.
    expect([...log].sort()).toEqual(['start reactor_create_rule', 'start reactor_list_rules']);
    gates.get('reactor_create_rule')!();
    await tick();
    expect(log).toContain('start call_tool');
    gates.get('call_tool')!();
    gates.get('reactor_list_rules')!();
    await Promise.all([a, b, c]);
  });
});

describe('reportResultTool', () => {
  it('truncates summary to 1,000 and notes to 500 chars and binds the step id (Req 5.1, 5.2)', async () => {
    let got: unknown;
    const t = reportResultTool(7, (r) => { got = r; });
    await t.execute!(
      { status: 'done', summary: 's'.repeat(1_500), ids: { dataElementId: 'DE1' }, notes: 'n'.repeat(900) },
      { toolCallId: 'c', messages: [] } as never
    );
    expect(got).toMatchObject({ stepId: 7, status: 'done', ids: { dataElementId: 'DE1' } });
    expect((got as { summary: string }).summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect((got as { notes: string }).notes).toHaveLength(MAX_NOTES_CHARS);
  });

  it('coerces non-string ids and tolerates missing ids', async () => {
    let got: unknown;
    const t = reportResultTool(1, (r) => { got = r; });
    await t.execute!({ status: 'done', summary: 'ok', ids: { n: 5 as unknown as string } }, { toolCallId: 'c', messages: [] } as never);
    expect((got as { ids: Record<string, string> }).ids).toEqual({ n: '5' });
  });
});

describe('buildWorkerBrief', () => {
  it('lists folded reasoning steps so the worker does them first', () => {
    const brief = buildWorkerBrief({
      runGoal: 'g',
      step: { id: 6, description: 'populate library', tool: 'reactor_create_library', expectedOutput: 'library id', dependsOn: [5], status: 'pending' },
      deps: [],
      folded: [{ id: 3, description: 'ground delegates', tool: null, expectedOutput: 'delegate ids', dependsOn: [], status: 'done' }],
    });
    expect(brief).toContain('do this reasoning yourself');
    expect(brief).toContain('Step 3: ground delegates → delegate ids');
  });

  it('includes the goal, step and dependency results but no transcripts (Req 4.4, 4.5)', () => {
    const brief = buildWorkerBrief({
      runGoal: 'Build the tags',
      step: makeStep(),
      deps: [{ stepId: 1, status: 'done', summary: 'read property state', ids: { propertyId: 'PR1' } }],
      knowledge: 'Launch data elements need a delegate id.',
    });
    expect(brief).toContain('Goal of the whole run: Build the tags');
    expect(brief).toContain('Create the data element');
    expect(brief).toContain('Step 1 [done]: read property state ids={"propertyId":"PR1"}');
    expect(brief).toContain('Launch data elements need a delegate id.');
    expect(brief).toContain('call report_result');
  });
});

describe('runWorker', () => {
  it('runs the step, forces report_result on the last step, and returns its result (Req 4.2, 4.6)', async () => {
    script = [
      { toolCall: { toolName: 'reactor_create_data_element', input: { id: 'x' } } },
      report({ status: 'done', summary: 'created', ids: { dataElementId: 'DE9' } }),
    ];
    const rec = await runWorker(baseInput());

    expect(executed.map((e) => e.name)).toEqual(['reactor_create_data_element']);
    expect(rec.status).toBe('done');
    expect(rec.result).toMatchObject({ stepId: 2, status: 'done', ids: { dataElementId: 'DE9' } });
    expect(rec.workerId).toBe('run1:w2:1');

    // maxSteps = 3, so the last allowed step forces report_result (Req 4.6).
    const forced = calls.find((c) => c.toolChoice?.type === 'tool');
    expect(forced?.toolChoice).toMatchObject({ type: 'tool', toolName: 'report_result' });

    // The worker was only ever handed its narrowed tool set (Req 4.2): the
    // off-group adobe_ tool never appears.
    for (const c of calls) {
      expect((c.tools ?? []).map((t) => t.name)).not.toContain('adobe_list_segments');
    }
  });

  it('marks the step failed when report_result reports failed (Req 5.4)', async () => {
    script = [report({ status: 'failed', summary: 'extension missing' })];
    const rec = await runWorker(baseInput());
    expect(rec.status).toBe('failed');
    expect(rec.error).toBe('extension missing');
  });

  it('tags its approval requests with its workerId (Req 11.3, 15.3)', async () => {
    const toolApproval = vi.fn(async () => 'not-applicable' as const);
    script = [
      { toolCall: { toolName: 'reactor_create_data_element', input: { id: 'x' } } },
      report({ status: 'done', summary: 'ok' }),
    ];
    await runWorker(baseInput({ shared: makeShared({ toolApproval }) }));
    expect(toolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: 'run1:w2:1', toolCall: expect.objectContaining({ toolName: 'reactor_create_data_element' }) })
    );
  });

  it('fails with "worker ended without a result" when none is reported (Req 4.7)', async () => {
    // The model only ever writes text, never calls report_result.
    script = [{ text: 'I looked around' }, { text: 'still nothing' }, { text: 'done' }];
    const rec = await runWorker(baseInput());
    expect(rec.status).toBe('failed');
    expect(rec.error).toBe('worker ended without a result');
  });

  it('restarts on a same-tier fallback when the model fails before any write (Req 10.1)', async () => {
    const onRestart = vi.fn();
    script = [
      { throw: 'quota exceeded' }, // first attempt fails before any tool call
      { toolCall: { toolName: 'reactor_create_data_element', input: { id: 'x' } } },
      report({ status: 'done', summary: 'created on fallback', ids: { dataElementId: 'DE2' } }),
    ];
    const rec = await runWorker(baseInput({ onRestart }));
    expect(onRestart).toHaveBeenCalledWith({ fromModelKey: 'test:a', toModelKey: 'test:b' });
    expect(rec.status).toBe('done');
    expect(rec.modelKey).toBe('test:b');
    // A restart is a new attempt on the same lane (Req 10.3).
    expect(rec.attempt).toBe(2);
    expect(rec.workerId).toBe('run1:w2:1');
  });

  it('fails the step instead of restarting when the model fails after a write (Req 10.2)', async () => {
    const onRestart = vi.fn();
    script = [
      { toolCall: { toolName: 'reactor_create_data_element', input: { id: 'x' } } }, // a write lands
      { throw: 'quota exceeded' }, // then the model fails
      report({ status: 'done', summary: 'should never run' }),
    ];
    const rec = await runWorker(baseInput({ onRestart }));
    expect(onRestart).not.toHaveBeenCalled();
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/already executed write/i);
    // The write ran exactly once — no restart replayed it.
    expect(executed.map((e) => e.name)).toEqual(['reactor_create_data_element']);
  });

  it('is cancelled when the run is already aborted (Req 9.3)', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    script = [report({ status: 'done', summary: 'unreachable' })];
    const rec = await runWorker(baseInput({ shared: makeShared({ abortSignal: controller.signal }) }));
    expect(rec.status).toBe('cancelled');
  });

  // Task 7.1 (Req 9.1, 9.2): every worker runs the SAME LaunchValidationGate
  // the run built (it is embedded in the tool set the coordinator narrows for
  // each worker). The gate must still block the library handoff until the
  // checks pass — a worker gets no bypass. Here the gate is wired into the
  // worker's handoff tool exactly as buildAiTools wires it for a live run:
  // observe() on success, gate() before the write throws when a check fails.
  it('keeps the shared gate blocking the library handoff for a worker (Req 9.1, 9.2)', async () => {
    const gate = new LaunchValidationGate();
    // The property only has `core`; the created rule component references an
    // uninstalled `web-sdk` extension, so the handoff must be blocked.
    gate.observe('reactor_list_extensions', {}, { data: [{ attributes: { name: 'core' } }] });
    gate.observe('reactor_create_rule_component', { delegate_descriptor_id: 'web-sdk::events::send', settings: {} }, {});

    let handoffSucceeded = false;
    // A gate-wrapped handoff tool, mirroring buildAiTools' execute wrapper:
    // gate() runs BEFORE the write and throws to block it.
    const handoff = tool({
      description: 'create the launch library',
      inputSchema: jsonSchema<{ name?: string }>({ type: 'object', properties: { name: { type: 'string' } } }),
      execute: async (input: unknown) => {
        gate.gate('reactor_create_library', input);
        handoffSucceeded = true;
        return { ok: true };
      },
    });

    const step = makeStep({ id: 5, tool: 'reactor_create_library', description: 'Populate the library' });
    // The model tries the handoff (blocked by the gate → tool error), then
    // reports the step failed.
    script = [
      { toolCall: { toolName: 'reactor_create_library', input: { name: 'lib' } } },
      report({ status: 'failed', summary: 'library handoff blocked by the validation gate' }),
    ];

    const rec = await runWorker(
      baseInput({
        step,
        tools: { reactor_create_library: handoff },
        catalog: makeCatalog(['reactor_create_library']),
        shared: makeShared({ launchGate: gate }),
      })
    );

    // The gate blocked the write (it never completed) and the step is failed.
    expect(handoffSucceeded).toBe(false);
    expect(rec.status).toBe('failed');
    // The worker ran as a Launch worker because the shared gate was present.
    const launchCall = calls.find((c) => (c.tools ?? []).some((t) => t.name === 'reactor_create_library'));
    expect(launchCall).toBeDefined();
  });
});
