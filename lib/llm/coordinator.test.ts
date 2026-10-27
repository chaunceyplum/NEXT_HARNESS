import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan, PlanStep } from './planner';
import type { WorkerRecord, WorkerResult } from './worker';

// The coordinator's scheduling, replanning and synthesis are exercised with a
// scripted runWorker (whose completion the test drives with deferred promises,
// so overlap is asserted from who is running when — not wall-clock timing) and
// with generateObject / streamText mocked for the replan and synthesis calls.
// This asserts: ready-step scheduling up to maxWorkers (3.1), serial writes in
// Launch runs (3.4), dependants receiving their deps' results (3.3/5.3), the
// replan cap (6.1/6.3), and the synthesis input (7.1).

// ── Deferred worker control ───────────────────────────────────────────────────
interface Deferred {
  resolve: (r: Partial<WorkerRecord> & { status: WorkerRecord['status'] }) => void;
  promise: Promise<WorkerRecord>;
  started: boolean;
  input: { step: PlanStep; deps: WorkerResult[]; modelKey: string };
}
let pending: Map<number, Deferred>;
/** Steps that were ever started, in start order. */
let startOrder: number[];

function makeDeferred(stepId: number, input: Deferred['input']): Deferred {
  let resolveFn!: Deferred['resolve'];
  const promise = new Promise<WorkerRecord>((resolve) => {
    resolveFn = (over) => {
      const base: WorkerRecord = {
        workerId: `run1:w${stepId}:1`,
        stepId,
        attempt: 1,
        modelKey: input.modelKey,
        steps: [{ stepNumber: 0, text: `worker ${stepId}`, toolCalls: [], toolResults: [] }],
        budgetUsage: { tokens: 1, costUsd: 0, durationMs: 0 },
        startedAt: new Date(0).toISOString(),
        ...over,
      };
      resolve(base);
    };
  });
  return { resolve: resolveFn, promise, started: false, input };
}

vi.mock('./worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker')>();
  return {
    ...actual,
    runWorker: vi.fn((input: Parameters<typeof import('./worker').runWorker>[0]) => {
      const stepId = input.step.id;
      startOrder.push(stepId);
      const d = makeDeferred(stepId, { step: input.step, deps: input.deps, modelKey: input.modelKey });
      d.started = true;
      pending.set(stepId, d);
      return d.promise;
    }),
  };
});

// ── Replan / synthesis control ──────────────────────────────────────────────────
let replanObject: { reason: string; steps: Array<{ description: string; tool: string | null; expectedOutput: string; dependsOn?: number[] }> } | Error = {
  reason: 'default',
  steps: [],
};
let synthesisText = 'final answer';
let synthesisPrompt = '';
let generateObjectCalls = 0;

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateObject: vi.fn(async () => {
      generateObjectCalls += 1;
      if (replanObject instanceof Error) throw replanObject;
      return { object: replanObject };
    }),
    streamText: vi.fn((opts: { messages: Array<{ content: string }> }) => {
      synthesisPrompt = opts.messages[0]?.content ?? '';
      return {
        get fullStream() {
          return (async function* () {
            yield { type: 'text-delta' as const, text: synthesisText };
          })();
        },
        text: Promise.resolve(synthesisText),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ totalTokens: 7 }),
      };
    }),
  };
});

vi.mock('./model-registry', () => ({
  resolveModel: () => ({}) as never,
  getDefaultModelKey: () => 'test:run',
}));

const { runOrchestrated, orchestrationConfig, shouldOrchestrate } = await import('./coordinator');
const { PlanTracker } = await import('./planner');
const { ModelHealthTracker } = await import('./model-health');
const { resolveBudget } = await import('./run-budget');

function makePlan(steps: Array<Partial<PlanStep> & { id: number }>): Plan {
  return {
    goal: 'Build the tags',
    version: 1,
    steps: steps.map((s) => ({
      description: `step ${s.id}`,
      tool: `reactor_read_${s.id}`,
      expectedOutput: 'ok',
      dependsOn: [],
      status: 'pending' as const,
      ...s,
    })),
  };
}

function baseInput(plan: Plan, over: Partial<Parameters<typeof runOrchestrated>[0]> = {}): Parameters<typeof runOrchestrated>[0] {
  return {
    tracker: new PlanTracker(plan),
    config: { maxWorkers: 3, maxReplans: 2, workerMaxSteps: 6, serialWrites: false },
    tools: {},
    catalog: [],
    runModelKey: 'test:run',
    budgetLimits: resolveBudget(),
    modelHealth: new ModelHealthTracker(),
    runId: 'run1',
    toolsConsidered: ['reactor_read_1', 'reactor_read_2'],
    ...over,
  };
}

/** Let the scheduler's microtasks (Promise.race, applyOutcome) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Resolve a started worker as done with the given result. */
function finishDone(stepId: number, result?: Partial<WorkerResult>) {
  const d = pending.get(stepId);
  if (!d) throw new Error(`step ${stepId} not running`);
  const res: WorkerResult = { stepId, status: 'done', summary: `did ${stepId}`, ids: {}, ...result };
  d.resolve({ status: 'done', result: res });
  pending.delete(stepId);
}
function finishFailed(stepId: number, summary = 'boom') {
  const d = pending.get(stepId);
  if (!d) throw new Error(`step ${stepId} not running`);
  d.resolve({ status: 'failed', result: { stepId, status: 'failed', summary, ids: {} }, error: summary });
  pending.delete(stepId);
}

beforeEach(() => {
  pending = new Map();
  startOrder = [];
  replanObject = { reason: 'default', steps: [] };
  synthesisText = 'final answer';
  synthesisPrompt = '';
  generateObjectCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('orchestrationConfig', () => {
  it('uses the smaller of the request cap and MAX_WORKERS', () => {
    vi.stubEnv('MAX_WORKERS', '3');
    expect(orchestrationConfig({ maxWorkers: 2 }, false).maxWorkers).toBe(2);
    expect(orchestrationConfig({ maxWorkers: 10 }, false).maxWorkers).toBe(3);
    expect(orchestrationConfig({}, false).maxWorkers).toBe(3);
    vi.unstubAllEnvs();
  });

  it('keeps write workers serial in a Launch run unless LAUNCH_PARALLEL_WRITES is set', () => {
    expect(orchestrationConfig({}, true).serialWrites).toBe(true);
    vi.stubEnv('LAUNCH_PARALLEL_WRITES', 'true');
    expect(orchestrationConfig({}, true).serialWrites).toBe(false);
    expect(orchestrationConfig({}, false).serialWrites).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('shouldOrchestrate', () => {
  const parallel = makePlan([{ id: 1 }, { id: 2 }]);
  const serial = makePlan([{ id: 1 }, { id: 2, dependsOn: [1] }]);

  it('is off whenever the flag is off', () => {
    expect(shouldOrchestrate('off', true, parallel)).toBe(false);
  });
  it('on requires an explicit request and two independent steps', () => {
    expect(shouldOrchestrate('on', true, parallel)).toBe(true);
    expect(shouldOrchestrate('on', undefined, parallel)).toBe(false);
    expect(shouldOrchestrate('on', true, serial)).toBe(false);
  });
  it('always runs unless the request opts out', () => {
    expect(shouldOrchestrate('always', undefined, parallel)).toBe(true);
    expect(shouldOrchestrate('always', false, parallel)).toBe(false);
  });
  it('needs a plan', () => {
    expect(shouldOrchestrate('always', true, undefined)).toBe(false);
  });
});

describe('runOrchestrated scheduling', () => {
  it('starts ready steps up to maxWorkers and schedules dependants once their deps are done (Req 3.1, 3.3)', async () => {
    // 1 and 2 independent; 3 depends on both.
    const plan = makePlan([{ id: 1 }, { id: 2 }, { id: 3, dependsOn: [1, 2] }]);
    const run = runOrchestrated(baseInput(plan, { config: { maxWorkers: 3, maxReplans: 2, workerMaxSteps: 6, serialWrites: false } }));
    await tick();

    // Both independent steps run at once; step 3 waits on its deps (Req 3.3).
    expect([...pending.keys()].sort()).toEqual([1, 2]);

    finishDone(1, { ids: { a: 'A1' } });
    await tick();
    // Still blocked: step 2 not done yet.
    expect(pending.has(3)).toBe(false);

    finishDone(2, { ids: { b: 'B2' } });
    await tick();
    // Now step 3 is ready and running, with both results handed to it (Req 5.3).
    expect(pending.has(3)).toBe(true);
    const mockRunWorker = vi.mocked((await import('./worker')).runWorker);
    const step3Call = mockRunWorker.mock.calls.find((c) => c[0].step.id === 3);
    expect(step3Call?.[0].deps.map((d) => d.stepId).sort()).toEqual([1, 2]);

    finishDone(3);
    const result = await run;
    expect(result.orchestrated).toBe(true);
    expect(result.workers?.map((w) => w.stepId).sort()).toEqual([1, 2, 3]);
  });

  it('never runs more than maxWorkers at once (Req 3.1, 3.2)', async () => {
    const plan = makePlan([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    const run = runOrchestrated(baseInput(plan, { config: { maxWorkers: 2, maxReplans: 2, workerMaxSteps: 6, serialWrites: false } }));
    await tick();
    expect(pending.size).toBe(2);
    finishDone(1);
    await tick();
    // A slot freed → exactly one more starts, still capped at 2.
    expect(pending.size).toBe(2);
    finishDone(2);
    finishDone(3);
    await tick();
    finishDone(4);
    const result = await run;
    expect(result.workers).toHaveLength(4);
  });

  it('runs write workers one at a time in a Launch run (Req 3.4)', async () => {
    // Two independent write steps; serialWrites on.
    const plan = makePlan([
      { id: 1, tool: 'reactor_create_data_element' },
      { id: 2, tool: 'reactor_create_rule' },
    ]);
    const run = runOrchestrated(baseInput(plan, { config: { maxWorkers: 3, maxReplans: 2, workerMaxSteps: 6, serialWrites: true } }));
    await tick();
    // Only the first write runs; the second waits even though a slot is free.
    expect(pending.size).toBe(1);
    const first = [...pending.keys()][0];
    finishDone(first);
    await tick();
    expect(pending.size).toBe(1);
    const second = [...pending.keys()][0];
    expect(second).not.toBe(first);
    finishDone(second);
    const result = await run;
    expect(result.workers).toHaveLength(2);
  });
});

describe('runOrchestrated replanning (Req 6.1, 6.3)', () => {
  it('waits for running workers, then replans once after a failure', async () => {
    const plan = makePlan([{ id: 1 }, { id: 2 }]);
    replanObject = { reason: 'retry', steps: [{ description: 'recover', tool: 'reactor_read_9', expectedOutput: 'ok' }] };
    const run = runOrchestrated(baseInput(plan, { config: { maxWorkers: 3, maxReplans: 2, workerMaxSteps: 6, serialWrites: false } }));
    await tick();
    expect(pending.size).toBe(2);

    // Step 2 fails, but step 1 is still running — no replan yet (Req 6.1).
    finishFailed(2);
    await tick();
    expect(generateObjectCalls).toBe(0);

    // Once the running set drains, exactly one replan call fires.
    finishDone(1);
    await tick();
    expect(generateObjectCalls).toBe(1);

    // The replanned step is scheduled.
    expect([...pending.keys()]).toEqual([expect.any(Number)]);
    const newStep = [...pending.keys()][0];
    finishDone(newStep);
    const result = await run;
    expect(result.replans).toBe(1);
  });

  it('stops replanning at MAX_REPLANS and skips the rest (Req 6.3)', async () => {
    const plan = makePlan([{ id: 1 }]);
    // Each replan yields one more failing step, so the cap is what stops it.
    replanObject = { reason: 'retry', steps: [{ description: 'recover', tool: 'reactor_read_9', expectedOutput: 'ok' }] };
    const run = runOrchestrated(baseInput(plan, { config: { maxWorkers: 3, maxReplans: 1, workerMaxSteps: 6, serialWrites: false } }));
    await tick();
    finishFailed(1);
    await tick();
    // One replan allowed → one new step scheduled.
    expect(generateObjectCalls).toBe(1);
    const retry = [...pending.keys()][0];
    finishFailed(retry);
    await tick();
    // Cap reached: no second replan, run goes to synthesis.
    expect(generateObjectCalls).toBe(1);
    const result = await run;
    expect(result.replans).toBe(1);
    expect(result.finalText).toBe('final answer');
  });

  it('skips remaining steps when the replan call fails (Req 6.3)', async () => {
    const plan = makePlan([{ id: 1 }, { id: 2, dependsOn: [1] }]);
    replanObject = new Error('model unavailable');
    const run = runOrchestrated(baseInput(plan));
    await tick();
    finishFailed(1);
    await tick();
    const result = await run;
    // Step 2 never ran (its dep failed) and is skipped; synthesis still writes.
    expect(result.finalText).toBe('final answer');
    expect(startOrder).toEqual([1]);
  });
});

describe('runOrchestrated synthesis (Req 7.1, 7.2)', () => {
  it('streams one synthesis call built from every step result, including failures', async () => {
    const plan = makePlan([{ id: 1 }, { id: 2 }]);
    const deltas: string[] = [];
    const run = runOrchestrated(baseInput(plan, { onTextDelta: (d) => deltas.push(d) }));
    await tick();
    finishDone(1, { summary: 'created DE', ids: { dataElementId: 'DE1' } });
    finishFailed(2, 'rule creation failed');
    const result = await run;

    expect(result.finalText).toBe('final answer');
    expect(deltas).toEqual(['final answer']); // streamed, not buffered (Req 7.2)
    // Synthesis prompt carries every step's outcome, done and failed (Req 7.1).
    expect(synthesisPrompt).toContain('created DE');
    expect(synthesisPrompt).toContain('DE1');
    expect(synthesisPrompt).toContain('rule creation failed');
    expect(synthesisPrompt).toContain('[failed]');
  });

  it('falls back to a plain list of summaries when synthesis throws', async () => {
    const plan = makePlan([{ id: 1 }]);
    const run = runOrchestrated(baseInput(plan));
    await tick();
    // Make streamText throw on the synthesis call.
    const ai = await import('ai');
    vi.mocked(ai.streamText).mockImplementationOnce(() => {
      throw new Error('provider down');
    });
    finishDone(1, { summary: 'did the thing' });
    const result = await run;
    expect(result.finishReason).toBe('error');
    expect(result.finalText).toContain('did the thing');
  });
});
