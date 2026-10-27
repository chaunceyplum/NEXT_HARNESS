import { describe, expect, it, vi } from 'vitest';
import { buildPlanTools, formatPlan, MAX_PLAN_STEPS, normalisePlan, parallelWidth, PlanTracker, readySteps } from './planner';

const raw = {
  goal: 'Create a gold segment',
  steps: [
    { id: 10, description: 'Look up the loyalty field', tool: 'adobe_get_schema', expectedOutput: 'field path', dependsOn: [] },
    { id: 20, description: 'Create the segment', tool: 'adobe_create_segment', expectedOutput: 'segment id', dependsOn: [10] },
    { id: 30, description: 'Report', tool: null, expectedOutput: 'answer', dependsOn: [20] },
  ],
};

describe('normalisePlan', () => {
  it('renumbers from 1, remaps dependencies, and starts every step pending', () => {
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

  it('drops a dependency on a step trimmed by the cap', () => {
    const long = {
      goal: 'g',
      steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
        id: i + 1,
        description: `s${i}`,
        tool: null,
        expectedOutput: 'x',
        // The last step (trimmed away) is depended on by the first.
        dependsOn: i === 0 ? [MAX_PLAN_STEPS + 1] : [],
      })),
    };
    const plan = normalisePlan(long, 1);
    expect(plan.steps).toHaveLength(MAX_PLAN_STEPS);
    expect(plan.steps[0].dependsOn).toEqual([]);
  });

  it('rejects a dependency on a step id that was never declared', () => {
    const bad = {
      goal: 'g',
      steps: [
        { id: 1, description: 'a', tool: null, expectedOutput: 'x', dependsOn: [] },
        { id: 2, description: 'b', tool: null, expectedOutput: 'x', dependsOn: [99] },
      ],
    };
    expect(() => normalisePlan(bad, 1)).toThrow(/unknown step/);
  });

  it('rejects a dependency cycle', () => {
    const cyclic = {
      goal: 'g',
      steps: [
        { id: 1, description: 'a', tool: null, expectedOutput: 'x', dependsOn: [2] },
        { id: 2, description: 'b', tool: null, expectedOutput: 'x', dependsOn: [1] },
      ],
    };
    expect(() => normalisePlan(cyclic, 1)).toThrow(/cycle/);
  });

  it('rejects a self-dependency', () => {
    const selfDep = {
      goal: 'g',
      steps: [{ id: 1, description: 'a', tool: null, expectedOutput: 'x', dependsOn: [1] }],
    };
    expect(() => normalisePlan(selfDep, 1)).toThrow(/itself/);
  });
});

describe('readySteps', () => {
  it('returns pending steps whose dependencies are all done', () => {
    const plan = normalisePlan(raw, 1);
    // Nothing done yet: only the dependency-free step 1 is ready.
    expect(readySteps(plan).map((s) => s.id)).toEqual([1]);
    plan.steps[0].status = 'done';
    expect(readySteps(plan).map((s) => s.id)).toEqual([2]);
  });

  it('returns several independent steps at once', () => {
    const plan = normalisePlan(
      {
        goal: 'g',
        steps: [
          { id: 1, description: 'read', tool: null, expectedOutput: 'x', dependsOn: [] },
          { id: 2, description: 'a', tool: null, expectedOutput: 'x', dependsOn: [1] },
          { id: 3, description: 'b', tool: null, expectedOutput: 'x', dependsOn: [1] },
        ],
      },
      1
    );
    plan.steps[0].status = 'done';
    expect(readySteps(plan).map((s) => s.id)).toEqual([2, 3]);
  });
});

describe('parallelWidth', () => {
  it('is 1 for a fully serial plan', () => {
    expect(parallelWidth(normalisePlan(raw, 1))).toBe(1);
  });

  it('counts the largest set of mutually independent steps', () => {
    // 1 feeds 2 and 3 (independent of each other); 4 depends on both.
    const plan = normalisePlan(
      {
        goal: 'g',
        steps: [
          { id: 1, description: 'read', tool: null, expectedOutput: 'x', dependsOn: [] },
          { id: 2, description: 'a', tool: null, expectedOutput: 'x', dependsOn: [1] },
          { id: 3, description: 'b', tool: null, expectedOutput: 'x', dependsOn: [1] },
          { id: 4, description: 'join', tool: null, expectedOutput: 'x', dependsOn: [2, 3] },
        ],
      },
      1
    );
    expect(parallelWidth(plan)).toBe(2);
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

  it('keeps and remaps dependsOn on revised steps (Req 6.4)', () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    t.update(1, 'done'); // kept as id 1
    t.update(2, 'failed');
    // Kept done step is id 1; new steps become ids 2 and 3. The new step 2
    // needs the kept step (id 1); the new step 3 needs the new step 2 and the
    // kept step 1 — referenced by their final renumbered ids.
    const r = t.revise('reground', [
      { description: 'Add the field group', tool: 'adobe_update_schema', expectedOutput: 'schema version', dependsOn: [1] },
      { description: 'Create the segment', tool: 'adobe_create_segment', expectedOutput: 'segment id', dependsOn: [2, 1] },
    ]);
    expect(r.ok).toBe(true);
    // Kept done step keeps id 1; new steps become 2 and 3.
    expect(t.plan.steps.map((s) => [s.id, s.dependsOn])).toEqual([
      [1, []],
      [2, [1]],
      [3, [2, 1]],
    ]);
  });

  it('renumbers kept done steps from 1 so new steps never reuse an id', () => {
    const t = new PlanTracker({
      goal: 'g',
      version: 1,
      steps: [1, 2, 3, 4].map((id) => ({
        id,
        description: `s${id}`,
        tool: 'x',
        expectedOutput: 'e',
        dependsOn: id === 3 ? [2] : [],
        status: id === 1 ? ('failed' as const) : id < 4 ? ('done' as const) : ('pending' as const),
      })),
    });
    const r = t.revise('r', [
      { description: 'new A', tool: 'x', expectedOutput: 'e', dependsOn: [2] },
      { description: 'new B', tool: 'x', expectedOutput: 'e' },
    ]);
    expect(t.plan.steps.map((s) => [s.id, s.description, s.dependsOn])).toEqual([
      [1, 's2', []],
      [2, 's3', [1]],
      [3, 'new A', [2]],
      [4, 'new B', []],
    ]);
    expect([...(r.renumbered ?? [])]).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it('drops a revised dependsOn that references a step that no longer exists', () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    t.update(1, 'done'); // kept as id 1; the revised plan will have ids 1 and 2
    // The model references id 7, which the revised plan never has, so it is dropped.
    const r = t.revise('retry', [{ description: 'Create the segment', tool: 'adobe_create_segment', expectedOutput: 'segment id', dependsOn: [7] }]);
    expect(r.ok).toBe(true);
    expect(t.plan.steps.map((s) => [s.id, s.dependsOn])).toEqual([
      [1, []],
      [2, []],
    ]);
  });

  it('defaults dependsOn to empty when the model omits it', () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    t.update(1, 'done');
    const r = t.revise('r', [{ description: 'd', tool: null, expectedOutput: 'e' }]);
    expect(r.ok).toBe(true);
    expect(t.plan.steps[1].dependsOn).toEqual([]);
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

  it('revise_plan accepts and applies optional dependsOn', async () => {
    const t = new PlanTracker(normalisePlan(raw, 1));
    const tools = buildPlanTools(t);
    const opts = { toolCallId: 'c', messages: [] } as never;
    await tools.revise_plan.execute!(
      {
        reason: 'r',
        steps: [
          { description: 'first', tool: null, expectedOutput: 'e' },
          { description: 'second', tool: null, expectedOutput: 'e', dependsOn: [1] },
        ],
      },
      opts
    );
    expect(t.plan.steps.map((s) => [s.id, s.dependsOn])).toEqual([
      [1, []],
      [2, [1]],
    ]);
  });
});
