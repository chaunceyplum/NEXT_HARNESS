import { afterEach, describe, expect, it, vi } from 'vitest';

const objects: unknown[] = [];
const prompts: string[] = [];
const systems: string[] = [];

vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateObject: vi.fn(async ({ prompt, system }: { prompt: string; system: string }) => {
    prompts.push(prompt);
    systems.push(system);
    const next = objects.shift();
    if (next instanceof Error) throw next;
    return { object: next };
  }),
}));
vi.mock('./model-registry', () => ({ resolveModel: () => ({}) }));

const { parseLaunchBrief, launchRequirementsSchema } = await import('./launch-brief');

const requirements = {
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

afterEach(() => {
  objects.length = 0;
  prompts.length = 0;
  systems.length = 0;
});

describe('parseLaunchBrief', () => {
  it('returns the validated requirements object', async () => {
    objects.push(requirements);
    const r = await parseLaunchBrief('When a user clicks add-to-cart, track it and capture the SKU.');
    expect(r).toEqual(requirements);
  });

  it('puts the brief in the prompt and grounds the system message on the object model', async () => {
    objects.push(requirements);
    await parseLaunchBrief('track add-to-cart clicks');
    expect(prompts[0]).toContain('track add-to-cart clicks');
    expect(systems[0]).toContain('delegate_descriptor_id');
  });

  it('prepends optional context ahead of the brief', async () => {
    objects.push(requirements);
    await parseLaunchBrief('track add-to-cart clicks', undefined, 'Default property: web-prod');
    expect(prompts[0]).toContain('Default property: web-prod');
    expect(prompts[0].indexOf('Default property: web-prod')).toBeLessThan(prompts[0].indexOf('track add-to-cart clicks'));
  });

  it('propagates a model error instead of swallowing it', async () => {
    objects.push(new Error('throttled'));
    await expect(parseLaunchBrief('x')).rejects.toThrow('throttled');
  });
});

describe('launchRequirementsSchema', () => {
  it('accepts a well-formed requirements object', () => {
    expect(launchRequirementsSchema.safeParse(requirements).success).toBe(true);
  });

  it('allows null target property/library and null storage duration', () => {
    const sparse = {
      ...requirements,
      target: { propertyName: null, libraryName: null },
      dataElements: [{ ...requirements.dataElements[0], storageDuration: null, delegateDescriptorId: null, dataLayerReference: null }],
    };
    expect(launchRequirementsSchema.safeParse(sparse).success).toBe(true);
  });

  it('rejects an unknown rule component kind', () => {
    const bad = {
      ...requirements,
      rules: [{ ...requirements.rules[0], components: [{ kind: 'trigger', delegateDescriptorId: null, description: 'x', settings: {} }] }],
    };
    expect(launchRequirementsSchema.safeParse(bad).success).toBe(false);
  });
});
