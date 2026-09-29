import { afterEach, describe, expect, it } from 'vitest';
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
