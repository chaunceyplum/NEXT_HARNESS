import { describe, expect, it, vi } from 'vitest';

// POST /api/build as a job: a client disconnect doesn't stop the run, every
// step is checkpointed, the final record wins, and a reconnect replays.

let finishRun!: () => void;
const saved: Array<{ status: string; steps: number; result?: Record<string, unknown> }> = [];

// When set, the next runAgent call drives the orchestrator-worker callbacks
// instead of the plain single-agent path, so the worker-event and per-worker
// restart forwarding can be exercised end to end through the route.
type WorkerAgentOpts = {
  onStep?: (s: unknown, workerId?: string) => void;
  onWorkerStart?: (info: { workerId: string; stepId: number; modelKey: string; tools: string[] }) => void;
  onWorker?: (w: Record<string, unknown>) => void;
  onRestart?: (info: { fromModelKey: string; toModelKey: string; workerId?: string }) => void;
  approveTool?: (req: { toolCallId: string; toolName: string; input: unknown; reason: string; workerId?: string }) => Promise<{ approved: boolean }>;
  abortSignal?: AbortSignal;
  runId?: string;
};
let orchestratedScript: ((opts: WorkerAgentOpts) => void | Promise<void>) | null = null;

vi.mock('@/lib/llm/agent', () => ({
  runAgent: async (opts: WorkerAgentOpts) => {
    if (orchestratedScript) {
      const script = orchestratedScript;
      orchestratedScript = null;
      await script(opts);
      return {
        finalText: 'synthesised',
        steps: [{ stepNumber: 0, text: '', toolCalls: [], toolResults: [], workerId: 'r:w2:1' }],
        toolsConsidered: [],
        finishReason: 'stop',
        modelKey: 'm',
        usage: {},
        budgetUsage: { tokens: 0, durationMs: 0 },
        ragJudgments: [],
        orchestrated: true,
        replans: 1,
        workers: [{ workerId: 'r:w2:1', stepId: 2, attempt: 1, modelKey: 'm', status: 'done', steps: [], budgetUsage: { tokens: 1, durationMs: 1 }, startedAt: 'x' }],
      };
    }
    opts.onStep?.({ stepNumber: 0, text: '', toolCalls: [{ toolName: 'adobe_list_segments', input: {} }], toolResults: [] });
    await new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal?.reason));
    });
    return {
      finalText: 'done',
      steps: [{ stepNumber: 0, text: '', toolCalls: [], toolResults: [] }],
      toolsConsidered: [],
      finishReason: 'stop',
      modelKey: 'm',
      usage: {},
      budgetUsage: { tokens: 0, durationMs: 0 },
      ragJudgments: [],
    };
  },
}));
vi.mock('@/lib/execution-store', () => ({
  CHECKPOINT_SCHEMA_VERSION: 2,
  newRunId: () => `run-${Math.random().toString(36).slice(2)}`,
  saveExecution: async (r: { status: string; result?: { steps: unknown[] } }) => {
    saved.push({ status: r.status, steps: r.result?.steps.length ?? 0, result: r.result as Record<string, unknown> | undefined });
  },
}));

const audited: Array<{ type: string; actor: string; workerId?: string }> = [];
vi.mock('@/lib/audit-log', () => ({
  auditReads: () => false,
  recordAudit: async (events: typeof audited) => {
    audited.push(...events);
  },
}));
vi.mock('@/lib/online-judge', () => ({ shouldJudgeRun: () => false, judgeRun: async () => true }));

// Controllable active-run cap so the 429 path can be exercised without
// actually starting MAX_ACTIVE_RUNS concurrent runs. Defaults high so every
// other test runs as before.
let activeCapForTest = 1_000;
vi.mock('@/lib/llm/orchestration-config', () => ({
  maxActiveRuns: () => activeCapForTest,
}));

const { POST } = await import('./route');
const { resolveApproval } = await import('@/lib/llm/approvals');
const events = await import('../runs/[id]/events/route');
const cancel = await import('../runs/[id]/cancel/route');

const tick = () => new Promise((r) => setTimeout(r, 5));
const post = () =>
  POST(new Request('http://x/api/build', { method: 'POST', body: JSON.stringify({ description: 'list all segments please' }) }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function firstLines(res: Response, n: number) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (text.split('\n').filter(Boolean).length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  await reader.cancel();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('POST /api/build as a job', () => {
  it('survives a client disconnect, checkpoints each step, and replays on reconnect', async () => {
    saved.length = 0;
    const res = await post();
    const [start, step] = await firstLines(res, 2); // then the client goes away
    expect(start).toMatchObject({ type: 'run_start', seq: 1 });
    expect(step).toMatchObject({ type: 'step', seq: 2 });

    await tick();
    // The run_start checkpoint was superseded by the step's before its turn,
    // so only the newer one was written.
    expect(saved.map((s) => s.status)).toEqual(['running']);
    expect(saved[0].steps).toBe(1);

    finishRun();
    await tick();
    expect(saved.at(-1)).toMatchObject({ status: 'completed' });

    const replay = await (await events.GET(new Request('http://x'), params(start.runId))).text();
    expect(replay.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(['run_start', 'step', 'done']);
    expect(audited).toContainEqual(expect.objectContaining({ type: 'run_start', actor: 'anonymous' }));
  });

  it('stops only when cancelled, saving the run as failed with its steps', async () => {
    saved.length = 0;
    const res = await post();
    const [start] = await firstLines(res, 2);
    const stop = await cancel.POST(new Request('http://x', { method: 'POST', headers: { 'x-harness-user': 'alice' } }), params(start.runId));
    expect(stop.status).toBe(200);
    await tick();
    const replay = (await (await events.GET(new Request('http://x'), params(start.runId))).text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(replay.at(-1)).toMatchObject({ type: 'error', code: 'CANCELLED', error: expect.stringContaining('Stopped by alice.') });
    expect(saved.at(-1)).toMatchObject({ status: 'failed', steps: 1 });
  });

  it('404s for a run that is not live', async () => {
    expect((await events.GET(new Request('http://x'), params('nope'))).status).toBe(404);
    expect((await cancel.POST(new Request('http://x', { method: 'POST' }), params('nope'))).status).toBe(404);
  });
});

describe('POST /api/build — concurrency cap (Requirement 13.3)', () => {
  it('rejects with 429 TOO_MANY_RUNS once active runs reach MAX_ACTIVE_RUNS', async () => {
    activeCapForTest = 0; // every request is at/over the cap
    try {
      const res = await post();
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'TOO_MANY_RUNS' });
    } finally {
      activeCapForTest = 1_000;
    }
  });

  it('starts the run normally when under the cap', async () => {
    activeCapForTest = 1_000;
    const res = await post();
    expect(res.status).toBe(200);
    const [start] = await firstLines(res, 1);
    expect(start).toMatchObject({ type: 'run_start' });
    // Stop the run so it doesn't leak into later tests.
    await cancel.POST(new Request('http://x', { method: 'POST' }), params(start.runId));
    await tick();
  });
});

describe('POST /api/build — orchestration input validation', () => {
  it('rejects a non-boolean orchestrate and an out-of-range maxWorkers', async () => {
    const bad = (body: Record<string, unknown>) =>
      POST(new Request('http://x/api/build', { method: 'POST', body: JSON.stringify({ description: 'list all segments please', ...body }) }));

    expect((await bad({ orchestrate: 'yes' })).status).toBe(400);
    expect((await bad({ maxWorkers: 0 })).status).toBe(400);
    expect((await bad({ maxWorkers: 2.5 })).status).toBe(400);
    expect((await bad({ maxWorkers: 99 })).status).toBe(400);
  });
});

describe('POST /api/build — orchestrated runs (Requirements 11.1, 11.3, 12.2)', () => {
  it('streams worker_start / worker_done, tags steps, drops only the restarted worker, and stores workers', async () => {
    saved.length = 0;
    // Drive the worker callbacks: two workers start; one step from each; a
    // per-worker restart drops only w1's step; both workers finish.
    orchestratedScript = (opts) => {
      opts.onWorkerStart?.({ workerId: 'r:w1:1', stepId: 1, modelKey: 'm', tools: ['reactor_get_property'] });
      opts.onWorkerStart?.({ workerId: 'r:w2:1', stepId: 2, modelKey: 'm', tools: ['reactor_create_data_element'] });
      opts.onStep?.({ stepNumber: 0, text: '', toolCalls: [], toolResults: [] }, 'r:w1:1');
      opts.onStep?.({ stepNumber: 1, text: '', toolCalls: [], toolResults: [] }, 'r:w2:1');
      // w1 restarts on a same-tier fallback: only its step is discarded.
      opts.onRestart?.({ fromModelKey: 'm', toModelKey: 'm2', workerId: 'r:w1:1' });
      opts.onStep?.({ stepNumber: 0, text: '', toolCalls: [], toolResults: [] }, 'r:w1:1');
      opts.onWorker?.({ workerId: 'r:w1:1', stepId: 1, attempt: 2, modelKey: 'm2', status: 'done', steps: [], budgetUsage: { tokens: 1, durationMs: 1 }, startedAt: 'x' });
      opts.onWorker?.({ workerId: 'r:w2:1', stepId: 2, attempt: 1, modelKey: 'm', status: 'done', steps: [], budgetUsage: { tokens: 1, durationMs: 1 }, startedAt: 'x' });
    };

    const res = await POST(
      new Request('http://x/api/build', { method: 'POST', body: JSON.stringify({ description: 'build data elements please', orchestrate: true }) })
    );
    expect(res.status).toBe(200);
    // Read the whole stream to completion (the run finishes on its own).
    const lines = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await tick();

    const types = lines.map((l) => l.type);
    expect(types).toContain('worker_start');
    expect(types).toContain('worker_done');

    const starts = lines.filter((l) => l.type === 'worker_start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ workerId: 'r:w1:1', stepId: 1, modelKey: 'm', tools: ['reactor_get_property'] });

    // Step events from workers carry the workerId (Requirement 11.3).
    const stepEvents = lines.filter((l) => l.type === 'step');
    expect(stepEvents.every((e) => typeof e.workerId === 'string')).toBe(true);

    // The restart event is tagged with the worker (Requirement 11.3).
    const restart = lines.find((l) => l.type === 'restart');
    expect(restart).toMatchObject({ workerId: 'r:w1:1' });

    const done = lines.find((l) => l.type === 'worker_done' && l.workerId === 'r:w1:1');
    expect(done).toMatchObject({ status: 'done', stepId: 1 });

    // Requirement 12.2: checkpoints happened on worker start/end, and the final
    // record stores the orchestration fields inside result.
    const final = saved.at(-1);
    expect(final).toMatchObject({ status: 'completed' });
    expect(final?.result).toMatchObject({ orchestrated: true, replans: 1 });
    expect((final?.result?.workers as unknown[]).length).toBe(1);
    // Per-worker restart: only w1's pre-restart step was dropped, so the final
    // running checkpoint keeps w2's step plus w1's re-run step (2 steps), not 3.
    const runningCheckpoints = saved.filter((s) => s.status === 'running');
    expect(runningCheckpoints.at(-1)?.steps).toBe(2);
  });
  // Requirement 9.6: a worker's approval request is tagged with its workerId,
  // on the streamed event and on the approval's audit entry.
  it('tags a worker\'s approval_request event and approval audit entry with the workerId', async () => {
    audited.length = 0;
    orchestratedScript = async (opts) => {
      const decision = opts.approveTool!({ toolCallId: 'tc-1', toolName: 'adobe_delete_segment', input: { id: 's1' }, reason: 'destructive', workerId: 'r:w2:1' });
      await tick();
      resolveApproval(opts.runId!, 'tc-1', true, 'alice');
      expect(await decision).toMatchObject({ approved: true });
    };

    const res = await POST(
      new Request('http://x/api/build', { method: 'POST', body: JSON.stringify({ description: 'delete the old segment', orchestrate: true }) })
    );
    const lines = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await tick();

    expect(lines.find((l) => l.type === 'approval_request')).toMatchObject({ toolCallId: 'tc-1', reason: 'destructive', workerId: 'r:w2:1' });
    expect(audited).toContainEqual(expect.objectContaining({ type: 'approval', actor: 'alice', workerId: 'r:w2:1' }));
  });
});

describe('POST /api/build — checkpoint writes', () => {
  it('writes only the newest waiting checkpoint, then the final record', async () => {
    saved.length = 0;
    // Five steps land before the first save gets its turn.
    orchestratedScript = (opts) => {
      for (let i = 0; i < 5; i++) opts.onStep?.({ stepNumber: i, text: '', toolCalls: [], toolResults: [] }, 'r:w1:1');
    };
    const res = await POST(
      new Request('http://x/api/build', { method: 'POST', body: JSON.stringify({ description: 'build data elements please', orchestrate: true }) })
    );
    await res.text();
    await tick();
    expect(saved.map((s) => s.status)).toEqual(['running', 'completed']);
    expect(saved[0].steps).toBe(5);
  });
});

describe('POST /api/build — publishTarget validation', () => {
  it('rejects a publishTarget that names no environment', async () => {
    const res = await POST(
      new Request('http://x/api/build', {
        method: 'POST',
        body: JSON.stringify({ description: 'tag the site', launchMode: true, publishTarget: { propertyId: 'PR1' } }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must name the environment/);
  });
});
