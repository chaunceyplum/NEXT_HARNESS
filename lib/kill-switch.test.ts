import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { tool, jsonSchema, type ToolSet } from 'ai';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { PlanStep } from './llm/planner';
import { engageKillSwitch, killSwitchStatus, registerRun, releaseKillSwitch, runsBlockedReason } from './kill-switch';

afterEach(() => {
  releaseKillSwitch();
  delete process.env.AGENT_DISABLED;
});

const run = () => ({ abort: new AbortController(), startedAt: Date.now(), user: 'alice', description: 'list segments' });

describe('kill switch', () => {
  it('allows runs until engaged', () => {
    expect(runsBlockedReason()).toBeUndefined();
    expect(killSwitchStatus().engaged).toBe(false);
  });

  it('aborts every active run and blocks new ones when engaged', () => {
    const a = run();
    const b = run();
    const offA = registerRun('a', a);
    const offB = registerRun('b', b);
    expect(killSwitchStatus().activeRuns.map((r) => r.runId)).toEqual(['a', 'b']);

    expect(engageKillSwitch('carol', 'bad deploy')).toBe(2);
    expect(a.abort.signal.aborted && b.abort.signal.aborted).toBe(true);
    expect((a.abort.signal.reason as Error).message).toMatch(/^Stopped by the kill switch \(carol: bad deploy\)/);
    expect(runsBlockedReason()).toMatch(/engaged by carol/);
    offA();
    offB();
    expect(killSwitchStatus().activeRuns).toEqual([]);
  });

  it('re-allows runs once released', () => {
    engageKillSwitch('carol');
    releaseKillSwitch();
    expect(runsBlockedReason()).toBeUndefined();
  });

  it('treats AGENT_DISABLED=true as engaged regardless of the runtime switch', () => {
    process.env.AGENT_DISABLED = 'true';
    expect(killSwitchStatus()).toMatchObject({ engaged: true, source: 'env' });
    expect(runsBlockedReason()).toMatch(/AGENT_DISABLED/);
  });
});

// ── Task 7.4: a kill-switch trip aborts every worker of an orchestrated run ─────
//
// A run registers its AbortController with the kill switch; each worker links a
// child controller to that run signal (worker.ts). Engaging the kill switch
// aborts the run signal, which must cancel every in-flight worker — not just
// one. The model mock below hangs each worker's first model call until its
// (child) abort signal fires, so when the kill switch trips mid-run every
// worker's call rejects with the abort reason and the worker ends 'cancelled'.

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

vi.mock('./llm/model-registry', () => {
  const entries = [{ key: 'test:a', label: 'a', provider: 'anthropic', modelId: 'claude-sonnet-5', tier: 'balanced' }];
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
        // Hang until this call's abort signal fires, then reject with its
        // reason — the SDK surfaces that as the stream's failure, which the
        // worker loop treats as an abort.
        doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(abortSignal?.reason ?? new Error('aborted'));
            if (abortSignal?.aborted) fail();
            else abortSignal?.addEventListener('abort', fail, { once: true });
          });
          // Never reached — the promise above only ever rejects.
          const parts: LanguageModelV4StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
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

const { runWorker } = await import('./llm/worker');
const { ModelHealthTracker } = await import('./llm/model-health');
const { RunLedger, resolveBudget } = await import('./llm/run-budget');

function makeStep(id: number): PlanStep {
  return {
    id,
    description: `step ${id}`,
    tool: 'reactor_create_data_element',
    expectedOutput: 'ok',
    dependsOn: [],
    status: 'pending',
  };
}

function makeToolSet(): ToolSet {
  return {
    reactor_create_data_element: tool({
      description: 'create data element',
      inputSchema: jsonSchema<{ id?: string }>({ type: 'object', properties: { id: { type: 'string' } } }),
      execute: async () => ({ ok: true }),
    }),
  };
}

describe('kill switch aborts every worker (Req 9.4)', () => {
  beforeEach(() => {
    releaseKillSwitch();
  });

  it('engaging the switch cancels every in-flight worker of a run, not just one', async () => {
    const abort = new AbortController();
    const off = registerRun('run1', { abort, startedAt: Date.now(), user: 'alice', description: 'launch tags' });

    const ledger = new RunLedger(resolveBudget(), 0, () => 0);
    const modelHealth = new ModelHealthTracker();
    const shared = { runId: 'run1', ledger, modelHealth, abortSignal: abort.signal };

    const makeInput = (id: number) => ({
      runGoal: 'Build the tags',
      step: makeStep(id),
      deps: [],
      tools: makeToolSet(),
      catalog: [{ name: 'reactor_create_data_element', description: '', inputSchema: { type: 'object' as const } }],
      modelKey: 'test:a',
      maxSteps: 3,
      shared,
      attempt: 1,
    });

    // Three workers, all hung on their first (child-signal-linked) model call.
    const workers = Promise.all([runWorker(makeInput(1)), runWorker(makeInput(2)), runWorker(makeInput(3))]);
    await new Promise((r) => setTimeout(r, 0));

    // One kill-switch trip aborts the run signal, which every worker's child
    // controller is linked to.
    const aborted = engageKillSwitch('carol', 'stop everything');
    expect(aborted).toBe(1); // one registered run

    const records = await workers;
    expect(records).toHaveLength(3);
    for (const rec of records) expect(rec.status).toBe('cancelled');

    off();
  });
});
