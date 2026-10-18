import { describe, expect, it } from 'vitest';
import { LAUNCH_ALWAYS_ON_TOOLS, launchShortlistQuery, seedLaunchPlan } from './launch-plan';
import { MAX_PLAN_STEPS } from './planner';
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
      'search_adobe_knowledge',
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

  it('chains each step after the previous one', () => {
    const plan = seedLaunchPlan(requirements);
    expect(plan.steps.map((s) => s.dependsOn)).toEqual([[], [1], [2], [3], [4], [5]]);
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
  it('includes knowledge grounding plus Reactor read and write tools', () => {
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('search_adobe_knowledge');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_list_extensions');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_list_data_elements');
    expect(LAUNCH_ALWAYS_ON_TOOLS).toContain('reactor_create_library');
  });

  it('lists no publish/build/transition tool (deliverable stops at a populated library)', () => {
    expect(LAUNCH_ALWAYS_ON_TOOLS.some((n) => /build|transition|publish/.test(n))).toBe(false);
  });
});
