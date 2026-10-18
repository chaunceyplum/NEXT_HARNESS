import { describe, expect, it } from 'vitest';
import {
  LAUNCH_EXAMPLES,
  launchExamplesPreamble,
  requirementTerms,
  scoreExample,
  selectLaunchExamples,
} from './launch-examples';
import { dataElementSchema, ruleComponentSchema } from './launch-validation';
import type { LaunchRequirements } from './launch-brief';

const clickRequirements: LaunchRequirements = {
  summary: 'Fire a click-tracking rule on the add-to-cart button.',
  target: { propertyName: 'web-prod', libraryName: 'cart-tracking' },
  rules: [
    {
      name: 'Add to cart click',
      description: 'Track clicks on the add-to-cart button.',
      components: [
        { kind: 'event', delegateDescriptorId: 'core::events::click', description: 'Click on .add-to-cart', settings: { elementSelector: '.add-to-cart' } },
        { kind: 'action', delegateDescriptorId: 'core::actions::custom-code', description: 'Send the event', settings: {} },
      ],
    },
  ],
  dataElements: [],
  dataLayerReferences: [],
  openQuestions: [],
};

const dataLayerRequirements: LaunchRequirements = {
  summary: 'Capture the cart SKU from the data layer and persist it for the session.',
  target: { propertyName: null, libraryName: null },
  rules: [],
  dataElements: [
    {
      name: 'Cart Item SKU',
      delegateDescriptorId: 'core::dataElements::javascript-variable',
      storageDuration: 'session',
      dataLayerReference: 'digitalData.cart.items',
      description: 'The SKU of the item added.',
    },
  ],
  dataLayerReferences: ['digitalData.cart.items'],
  openQuestions: [],
};

describe('LAUNCH_EXAMPLES', () => {
  it('every example component/data element matches the Phase 1 handoff contract', () => {
    for (const example of LAUNCH_EXAMPLES) {
      for (const component of example.ruleComponents) {
        expect(ruleComponentSchema.safeParse(component).success).toBe(true);
      }
      for (const element of example.dataElements) {
        expect(dataElementSchema.safeParse(element).success).toBe(true);
      }
    }
  });

  it('uses only Core delegates (installed in every property), so a copy passes the reference check', () => {
    for (const example of LAUNCH_EXAMPLES) {
      const delegates = [
        ...example.ruleComponents.map((c) => c.delegate_descriptor_id),
        ...example.dataElements.map((d) => d.delegate_descriptor_id),
      ];
      for (const id of delegates) expect(id.startsWith('core::')).toBe(true);
    }
  });
});

describe('requirementTerms', () => {
  it('flattens names, descriptions, split delegate ids, and data-layer refs', () => {
    const terms = requirementTerms(clickRequirements);
    expect(terms).toContain('click'); // from the delegate id core::events::click, split on ::
    expect(terms).toContain('cart');
    expect(terms).toContain('events');
  });

  it('drops stopwords and short tokens', () => {
    const terms = requirementTerms(clickRequirements);
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('on');
  });
});

describe('scoreExample', () => {
  it('counts the example keywords present in the requirement terms', () => {
    const reqTerms = new Set(requirementTerms(clickRequirements));
    const click = LAUNCH_EXAMPLES.find((e) => e.id === 'click-event-custom-code')!;
    expect(scoreExample(click, reqTerms)).toBeGreaterThan(0);
  });

  it('is zero when nothing distinctive overlaps', () => {
    const click = LAUNCH_EXAMPLES.find((e) => e.id === 'click-event-custom-code')!;
    expect(scoreExample(click, new Set(['merge', 'policy']))).toBe(0);
  });
});

describe('selectLaunchExamples', () => {
  it('ranks the closest example first for a click brief', () => {
    const picked = selectLaunchExamples(clickRequirements, 2);
    expect(picked[0].id).toBe('click-event-custom-code');
  });

  it('ranks the data-layer example first for a data-element brief', () => {
    const picked = selectLaunchExamples(dataLayerRequirements, 2);
    expect(picked[0].id).toBe('data-layer-element');
  });

  it('respects k', () => {
    expect(selectLaunchExamples(clickRequirements, 1)).toHaveLength(1);
  });

  it('returns nothing without requirements', () => {
    expect(selectLaunchExamples(undefined)).toEqual([]);
  });

  it('returns nothing when no example overlaps the brief', () => {
    const unrelated: LaunchRequirements = {
      ...clickRequirements,
      summary: 'xyzzy',
      rules: [],
      dataElements: [],
      dataLayerReferences: [],
    };
    expect(selectLaunchExamples(unrelated)).toEqual([]);
  });

  it('is deterministic: ties keep curated order', () => {
    expect(selectLaunchExamples(clickRequirements)).toEqual(selectLaunchExamples(clickRequirements));
  });
});

describe('launchExamplesPreamble', () => {
  it('renders the selected examples as JSON few-shot blocks', () => {
    const preamble = launchExamplesPreamble(selectLaunchExamples(clickRequirements, 1));
    expect(preamble).toContain('Reference examples');
    expect(preamble).toContain('core::events::click');
    expect(preamble).toContain('delegate_descriptor_id');
  });

  it('tells the model to pattern-match, not copy the examples verbatim', () => {
    const preamble = launchExamplesPreamble(selectLaunchExamples(clickRequirements, 1));
    expect(preamble.toLowerCase()).toContain('do not copy');
  });

  it('is empty when there are no examples to show', () => {
    expect(launchExamplesPreamble([])).toBe('');
  });
});
