import { describe, expect, it } from 'vitest';
import {
  LAUNCH_ALWAYS_ON_TOOLS,
  LAUNCH_PUBLISH_ALWAYS_ON_TOOLS,
  launchAlwaysOnTools,
  launchShortlistQuery,
  seedLaunchPlan,
} from './launch-plan';
import { MAX_PLAN_STEPS, parallelWidth } from './planner';
import type { LaunchRequirements } from './launch-brief';

const requirements: LaunchRequirements = {
  summary: 'Fire a click-tracking rule on the add-to-cart button.',
  target: { propertyName: 'web-prod', libraryName: 'cart-tracking' },
  rules: [
    {
      name: 'Add to cart click',
      description: 'Track clicks on the add-to-cart button.',
      components: [
        { kind: 'event', delegateDescriptorId: 'core::events::click', description: 'Click on .add-to-cart', settings: { elementSelector: '.add-to-cart' } },
        { kind: 'action', delegateDescriptorId: 'core::actions::customCode', description: 'Send the event', settings: {} },
      ],
    },
  ],
  dataElements: [
    {
      name: 'Cart Item SKU',
      delegateDescriptorId: 'core::dataElements::variable',
      storageDuration: 'session',
      dataLayerReference: 'digitalData.cart.items',
      description: 'The SKU of the item added.',
    },
  ],
  dataLayerReferences: ['digitalData.cart.items'],
  openQuestions: [],
};

describe('seedLaunchPlan', () => {
  it('builds the fixed grounding backbone: read -> ground -> generate -> validate -> populate', () => {
    const plan = seedLaunchPlan();
    // Renumbered from 1 by normalisePlan, every step pending, within the cap.
    expect(plan.steps.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
    expect(plan.version).toBe(1);

    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toEqual([
      'reactor_list_extensions',
      'reactor_list_data_elements',
      null, // ground in the planning-stage KB excerpts
      null, // generate components
      null, // validate
      'reactor_create_library',
    ]);
  });

  it('stops at a populated library and never publishes', () => {
    const plan = seedLaunchPlan();
    const text = JSON.stringify(plan).toLowerCase();
    expect(text).toContain('do not publish');
    expect(plan.steps.some((s) => s.tool?.includes('build') || s.tool?.includes('transition'))).toBe(false);
  });

  it('specialises the goal and step wording from the requirements when present', () => {
    const plan = seedLaunchPlan(requirements);
    expect(plan.goal).toBe(requirements.summary);
    const text = JSON.stringify(plan);
    expect(text).toContain('web-prod');
    expect(text).toContain('cart-tracking');
  });

  it('falls back to a generic goal and property/library references without requirements', () => {
    const plan = seedLaunchPlan();
    expect(plan.goal).toMatch(/populate a library/i);
    expect(JSON.stringify(plan)).toContain('the target property');
  });

  it('encodes the backbone DAG: the two reads are independent, the rest stay ordered (Req 9.2)', () => {
    const plan = seedLaunchPlan(requirements);
    // 1 read extensions, 2 read data elements (independent) -> 3 ground (both
    // reads) -> 4 generate -> 5 validate (reads + generate) -> 6 populate.
    expect(plan.steps.map((s) => s.dependsOn)).toEqual([[], [], [1, 2], [3], [1, 2, 4], [5]]);
  });

  it('lets the two property reads run in parallel (parallelWidth >= 2) so orchestration can help', () => {
    expect(parallelWidth(seedLaunchPlan(requirements))).toBe(2);
  });

  it('keeps the publish backbone ordered after the populated library', () => {
    const plan = seedLaunchPlan(requirements, true);
    // 7 build depends on 6 (library); 8 transition depends on 7 (build).
    expect(plan.steps[6].dependsOn).toEqual([6]);
    expect(plan.steps[7].dependsOn).toEqual([7]);
  });
});

describe('launchShortlistQuery', () => {
  it('returns the raw input unchanged without requirements', () => {
    expect(launchShortlistQuery('track add-to-cart clicks')).toBe('track add-to-cart clicks');
  });

  it('keeps the raw input and appends the distinctive requirement terms', () => {
    const q = launchShortlistQuery('track add-to-cart clicks', requirements);
    expect(q.startsWith('track add-to-cart clicks')).toBe(true);
    // Target, delegate ids, data element + data-layer references all surface.
    expect(q).toContain('web-prod');
    expect(q).toContain('cart-tracking');
    expect(q).toContain('core::events::click');
    expect(q).toContain('core::dataElements::variable');
    expect(q).toContain('digitalData.cart.items');
    expect(q).toContain('Reactor');
  });

  it('omits null delegate ids and references', () => {
    const sparse: LaunchRequirements = {
      ...requirements,
      target: { propertyName: null, libraryName: null },
      rules: [{ ...requirements.rules[0], components: [{ kind: 'event', delegateDescriptorId: null, description: 'x', settings: {} }] }],
      dataElements: [{ ...requirements.dataElements[0], delegateDescriptorId: null, dataLayerReference: null }],
      dataLayerReferences: [],
    };
    const q = launchShortlistQuery('x', sparse);
    expect(q).not.toContain('null');
  });
});

describe('LAUNCH_ALWAYS_ON_TOOLS', () => {
  it('includes Reactor read and write tools but no knowledge search', () => {
    expect(LAUNCH_ALWAYS_ON_TOOLS).not.toContain('search_adobe_knowledge');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_list_extensions');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_list_data_elements');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_create_library');
  });

  it('lists no publish/build/transition tool (deliverable stops at a populated library)', () => {
    expect(LAUNCH_ALWAYS_ON_TOOLS.some((n) => /build|transition|publish/.test(n))).toBe(false);
  });
});

describe('launchAlwaysOnTools', () => {
  it('returns exactly the library-only set when publishing is off (byte-identical)', () => {
    expect(launchAlwaysOnTools(false)).toEqual(LAUNCH_ALWAYS_ON_TOOLS);
  });

  it('adds the build→poll→transition pipeline (and environment reads) when publishing is on', () => {
    const tools = launchAlwaysOnTools(true);
    for (const name of LAUNCH_ALWAYS_ON_TOOLS) expect(tools).toContain(name);
    for (const name of LAUNCH_PUBLISH_ALWAYS_ON_TOOLS) expect(tools).toContain(name);
    expect(tools).toContain('reactor_get_environment');
    expect(tools).toContain('reactor_build_library');
    expect(tools).toContain('reactor_get_build');
    expect(tools).toContain('reactor_transition_library');
  });
});

describe('seedLaunchPlan — publish backbone', () => {
  it('is byte-identical to today when publishEnabled is omitted/false', () => {
    expect(seedLaunchPlan(requirements, false)).toEqual(seedLaunchPlan(requirements));
    const text = JSON.stringify(seedLaunchPlan(requirements, false)).toLowerCase();
    expect(text).not.toContain('reactor_transition_library');
  });

  it('appends build and transition steps for a publish run, within the step cap', () => {
    const plan = seedLaunchPlan(requirements, true);
    const tools = plan.steps.map((s) => s.tool);
    expect(tools).toContain('reactor_build_library');
    expect(tools).toContain('reactor_transition_library');
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
    // The populate step still comes before the build + transition.
    const populate = tools.indexOf('reactor_create_library');
    expect(tools.indexOf('reactor_build_library')).toBeGreaterThan(populate);
    expect(tools.indexOf('reactor_transition_library')).toBeGreaterThan(tools.indexOf('reactor_build_library'));
  });

  it('seeds a transition to dev/staging only — never one that targets production', () => {
    const plan = seedLaunchPlan(requirements, true);
    const transition = plan.steps.find((s) => s.tool === 'reactor_transition_library');
    expect(transition).toBeDefined();
    const transitionText = `${transition!.description} ${transition!.expectedOutput}`.toLowerCase();
    // The seeded transition targets dev/staging and explicitly disallows prod.
    expect(transitionText).toMatch(/development\/staging|dev\/staging/);
    expect(transitionText).toMatch(/action "submit"/);
    expect(transitionText).toMatch(/never "approve" or "publish"/);
  });
});
