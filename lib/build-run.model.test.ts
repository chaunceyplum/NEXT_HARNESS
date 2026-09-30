import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from './llm/agent';
import type { ExecutionRecord } from './types';

const saved: ExecutionRecord[] = [];
let agentBehavior: (opts: RunAgentOptions) => Promise<unknown>;

vi.mock('@/lib/llm/agent', () => ({ runAgent: (opts: RunAgentOptions) => agentBehavior(opts) }));
vi.mock('@/lib/execution-store', () => ({
  CHECKPOINT_SCHEMA_VERSION: 1,
  newRunId: () => 'run-1',
  saveExecution: async (record: ExecutionRecord) => {
    saved.push(record);
  },
}));
vi.mock('@/lib/audit-log', () => ({ auditReads: () => false, recordAudit: async () => {} }));
vi.mock('@/lib/kill-switch', () => ({ registerRun: () => () => {} }));

const { startBuildRun } = await import('./build-run');

async function runToEnd(model?: string): Promise<ExecutionRecord> {
  const job = startBuildRun({ description: 'list segments', model }, 'tester');
  // A job signals completion to its listeners with null.
  await new Promise<void>((resolve) => {
    if (job.done) return resolve();
    job.listeners.add((event) => {
      if (event === null) resolve();
    });
  });
  const last = saved.at(-1);
  if (!last) throw new Error('nothing saved');
  return last;
}

const route = (modelKey: string) => ({ category: 'lookup' as const, confidence: 1, reason: 'test', via: 'rules' as const, modelKey });

describe('startBuildRun failure attribution', () => {
  beforeEach(() => {
    saved.length = 0;
  });

  it('saves a failed "auto" run under the model it was routed to', async () => {
    agentBehavior = async (opts) => {
      opts.onRoute?.(route('bedrock:cheap'));
      throw new Error('[chat model call (bedrock:cheap)] Forbidden');
    };
    const record = await runToEnd('auto');
    expect(record.status).toBe('failed');
    expect(record.model).toBe('bedrock:cheap');
  });

  it('saves a failed run under the fallback model it last ran on', async () => {
    agentBehavior = async (opts) => {
      opts.onRestart?.({ fromModelKey: 'anthropic:sonnet', toModelKey: 'anthropic:sonnet-5-5' });
      throw new Error('[chat model call (anthropic:sonnet-5-5)] invalid x-api-key');
    };
    const record = await runToEnd('anthropic:sonnet');
    expect(record.model).toBe('anthropic:sonnet-5-5');
  });

  it('keeps the requested model when the run fails before any routing', async () => {
    agentBehavior = async () => {
      throw new Error('boom');
    };
    const record = await runToEnd('bedrock:balanced');
    expect(record.model).toBe('bedrock:balanced');
  });
});
