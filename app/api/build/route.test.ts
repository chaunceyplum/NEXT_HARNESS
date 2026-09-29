import { describe, expect, it, vi } from 'vitest';

// POST /api/build as a job: a client disconnect doesn't stop the run, every
// step is checkpointed, the final record wins, and a reconnect replays.

let finishRun!: () => void;
const saved: Array<{ status: string; steps: number }> = [];

vi.mock('@/lib/llm/agent', () => ({
  runAgent: async (opts: { onStep?: (s: unknown) => void; abortSignal?: AbortSignal }) => {
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
  CHECKPOINT_SCHEMA_VERSION: 1,
  newRunId: () => `run-${Math.random().toString(36).slice(2)}`,
  saveExecution: async (r: { status: string; result?: { steps: unknown[] } }) => {
    saved.push({ status: r.status, steps: r.result?.steps.length ?? 0 });
  },
}));

const audited: Array<{ type: string; actor: string }> = [];
vi.mock('@/lib/audit-log', () => ({
  auditReads: () => false,
  recordAudit: async (events: Array<{ type: string; actor: string }>) => {
    audited.push(...events);
  },
}));
vi.mock('@/lib/online-judge', () => ({ shouldJudgeRun: () => false, judgeRun: async () => true }));

const { POST } = await import('./route');
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
    expect(saved.map((s) => s.status)).toEqual(['running', 'running']);
    expect(saved[1].steps).toBe(1);

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
