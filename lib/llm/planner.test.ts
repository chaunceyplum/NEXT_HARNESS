import { describe, expect, it, vi } from 'vitest';
import { buildPlanTools, formatPlan, MAX_PLAN_STEPS, normalisePlan, PlanTracker } from './planner';

const raw = {
  goal: 'Create a gold segment',
  steps: [
    { id: 10, description: 'Look up the loyalty field', tool: 'adobe_get_schema', expectedOutput: 'field path', dependsOn: [] },
    { id: 20, description: 'Create the segment', tool: 'adobe_create_segment', expectedOutput: 'segment id', dependsOn: [10, 99] },
    { id: 30, description: 'Report', tool: null, expectedOutput: 'answer', dependsOn: [20, 30] },
  ],
};

describe('normalisePlan', () => {
  it('renumbers from 1, keeps only earlier dependencies, and starts every step pending', () => {
    const plan = normalisePlan(raw, 1);
    expect(plan.steps.map((s) => [s.id, s.dependsOn, s.status])).toEqual([
      [1, [], 'pending'],
      [2, [1], 'pending'],
      [3, [2], 'pending'],
    ]);
  });

  it('caps the plan length', () => {
    const long = { goal: 'g', steps: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, description: `s${i}`, tool: null, expectedOutput: 'x', dependsOn: [] })) };
    expect(normalisePlan(long, 1).steps).toHaveLength(MAX_PLAN_STEPS);
  });
});

describe('PlanTracker', () => {
  it('updates step status and notes, rejecting unknown steps', () => {
    const onChange = vi.fn();
    const t = new PlanTracker(normalisePlan(raw, 1), onChange);
    expect(t.update(1, 'done', 'loyalty.tier')).toMatchObject({ ok: true });
    expect(t.plan.steps[0]).toMatchObject({ status: 'done', note: 'loyalty.tier' });
    expect(t.update(9, 'done').ok).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('revises only the unfinished steps, keeps done ones, and bumps the version', () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    t.update(1, 'done');
    t.update(2, 'failed', '422');
    const r = t.revise('field missing from union schema', [
      { description: 'Add the field group to the profile schema', tool: 'adobe_update_schema', expectedOutput: 'schema version' },
      { description: 'Create the segment', tool: 'adobe_create_segment', expectedOutput: 'segment id' },
    ]);
    expect(r.ok).toBe(true);
    expect(t.plan.version).toBe(2);
    expect(t.plan.steps.map((s) => [s.id, s.status])).toEqual([
      [1, 'done'],
      [2, 'pending'],
      [3, 'pending'],
    ]);
    expect(t.plan.steps[1].note).toMatch(/revised: field missing/);
  });

  it('refuses a revision that would exceed the cap', () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ description: 'x', tool: null, expectedOutput: 'y' }));
    expect(t.revise('r', many).ok).toBe(false);
  });
});

describe('plan tools', () => {
  it('update_plan and revise_plan act on the tracker', async () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    const tools = buildPlanTools(t);
    const opts = { toolCallId: 'c', messages: [] } as never;
    await tools.update_plan.execute!({ stepId: 1, status: 'running' }, opts);
    expect(t.plan.steps[0].status).toBe('running');
    const out = await tools.revise_plan.execute!({ reason: 'r', steps: [{ description: 'd', tool: null, expectedOutput: 'e' }] }, opts);
    expect(out).toMatchObject({ ok: true });
    expect(formatPlan(t.plan)).toContain('1. [pending] d');
  });
});
