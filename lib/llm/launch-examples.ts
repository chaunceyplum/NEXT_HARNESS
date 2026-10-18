/**
 * Reference examples for few-shot Launch generation (Phase 5).
 *
 * WHY A LOCAL FILE AND NOT A SEEDED KB:
 * The only knowledge base this agent can reach is search_adobe_knowledge, an
 * MCP-owned tool. It is filtered against the live MCP catalog in agent.ts
 * (ALWAYS_ON_TOOLS / LAUNCH_ALWAYS_ON_TOOLS) and read through
 * executeMcpToolWithRetry — there is no write/index path from this repo into
 * it, so it cannot be seeded here. Rather than invent an upstream dependency,
 * Phase 5 keeps a small curated set of known-good rule/data-element example
 * JSON documents in-repo and retrieves the closest ones to the Phase 2
 * requirements object (launch-brief.ts) to show the model before it generates.
 *
 * The examples match the Phase 1 object-model contract the validation gate
 * enforces (launch-validation.ts): a rule component carries a
 * delegate_descriptor_id in `extension::type::delegate` form plus a settings
 * object; a data element carries a name, a delegate_descriptor_id, settings,
 * and a storage_duration ("pageview" | "session" | "visitor", or none). They
 * are documentation, not live data — so they stay deliberately small and only
 * use Core delegates every property already has installed.
 *
 * Retrieval is deterministic and instant (no model/network call), mirroring
 * retrieval-hints.ts's term-overlap grading: each example is scored by how many
 * of its distinctive terms appear in the requirements object, and the top k are
 * returned for injection into the generation step.
 */

import type { LaunchRequirements } from './launch-brief';

/** A rule component in the Phase 1 handoff shape the validation gate checks. */
export interface ExampleRuleComponent {
  kind: 'event' | 'condition' | 'action';
  delegate_descriptor_id: string;
  settings: Record<string, unknown>;
}

/** A data element in the Phase 1 handoff shape the validation gate checks. */
export interface ExampleDataElement {
  name: string;
  delegate_descriptor_id: string;
  settings: Record<string, unknown>;
  storage_duration?: 'pageview' | 'session' | 'visitor';
}

/** One known-good reference the model can pattern-match a brief against. */
export interface LaunchExample {
  /** Stable id used in tests and logs. */
  id: string;
  /** One line on what this example demonstrates. */
  title: string;
  /** Distinctive retrieval terms (lowercased, matched against the brief). */
  keywords: string[];
  ruleComponents: ExampleRuleComponent[];
  dataElements: ExampleDataElement[];
}

/**
 * The curated set. Small on purpose — each is a canonical pattern a tagging
 * brief tends to reduce to, built from Core delegates only so a generated copy
 * passes the reference check against any property.
 */
export const LAUNCH_EXAMPLES: readonly LaunchExample[] = [
  {
    id: 'click-event-custom-code',
    title: 'Click event firing a custom-code action',
    keywords: ['click', 'button', 'event', 'custom', 'code', 'selector', 'track', 'cta', 'link'],
    ruleComponents: [
      {
        kind: 'event',
        delegate_descriptor_id: 'core::events::click',
        settings: { elementSelector: '.add-to-cart', bubbleFireIfParent: true },
      },
      {
        kind: 'action',
        delegate_descriptor_id: 'core::actions::custom-code',
        settings: { source: "digitalData.event = 'addToCart';", language: 'javascript' },
      },
    ],
    dataElements: [],
  },
  {
    id: 'page-load-direct-call',
    title: 'Page-load rule with a condition and a set-variable action',
    keywords: ['page', 'load', 'pageview', 'window', 'loaded', 'dom', 'ready', 'path', 'condition', 'url'],
    ruleComponents: [
      {
        kind: 'event',
        delegate_descriptor_id: 'core::events::window-loaded',
        settings: {},
      },
      {
        kind: 'condition',
        delegate_descriptor_id: 'core::conditions::path',
        settings: { paths: [{ value: '/checkout', valueIsRegex: false }] },
      },
      {
        kind: 'action',
        delegate_descriptor_id: 'core::actions::set-variable',
        settings: { name: 'pageName', value: '%Page Name%' },
      },
    ],
    dataElements: [
      {
        name: 'Page Name',
        delegate_descriptor_id: 'core::dataElements::javascript-variable',
        settings: { path: 'digitalData.page.pageInfo.pageName' },
        storage_duration: 'pageview',
      },
    ],
  },
  {
    id: 'data-layer-element',
    title: 'Data element reading a data-layer value, persisted for the session',
    keywords: ['data', 'element', 'layer', 'variable', 'value', 'digitaldata', 'datalayer', 'capture', 'sku', 'cart', 'persist', 'session'],
    ruleComponents: [],
    dataElements: [
      {
        name: 'Cart Item SKU',
        delegate_descriptor_id: 'core::dataElements::javascript-variable',
        settings: { path: 'digitalData.cart.items.0.productInfo.sku' },
        storage_duration: 'session',
      },
    ],
  },
  {
    id: 'direct-call-event',
    title: 'Direct-call event firing a custom-code action',
    keywords: ['direct', 'call', 'trigger', 'event', '_satellite', 'track', 'manual', 'programmatic'],
    ruleComponents: [
      {
        kind: 'event',
        delegate_descriptor_id: 'core::events::direct-call',
        settings: { identifier: 'addToCart' },
      },
      {
        kind: 'action',
        delegate_descriptor_id: 'core::actions::custom-code',
        settings: { source: "console.log('addToCart fired', %Cart Item SKU%);", language: 'javascript' },
      },
    ],
    dataElements: [],
  },
];

// ── Retrieval ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it its of on or should that the this to use what when where which who why with you your we our my'.split(' ')
);

/** Lowercased, de-duplicated distinctive terms from free text (mirrors retrieval-hints.ts). */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

/**
 * Flatten a requirements object into the bag of terms worth matching an example
 * against: the summary, rule/data-element names and descriptions, every
 * delegate id, and the data-layer references. Delegate ids are split on `::` so
 * "core::events::click" also contributes "click".
 */
export function requirementTerms(requirements: LaunchRequirements): string[] {
  const parts: string[] = [requirements.summary];

  for (const rule of requirements.rules) {
    parts.push(rule.name, rule.description);
    for (const component of rule.components) {
      parts.push(component.kind, component.description);
      if (component.delegateDescriptorId) parts.push(component.delegateDescriptorId.replace(/::/g, ' '));
    }
  }

  for (const element of requirements.dataElements) {
    parts.push(element.name, element.description);
    if (element.delegateDescriptorId) parts.push(element.delegateDescriptorId.replace(/::/g, ' '));
    if (element.dataLayerReference) parts.push(element.dataLayerReference);
  }

  parts.push(...requirements.dataLayerReferences);

  return terms(parts.join(' '));
}

/**
 * Score one example against a requirement term set: the count of the example's
 * keywords that appear among the requirement terms. Deterministic; higher is a
 * closer match. Zero means nothing distinctive overlapped.
 */
export function scoreExample(example: LaunchExample, reqTerms: Set<string>): number {
  let score = 0;
  for (const keyword of example.keywords) {
    if (reqTerms.has(keyword)) score += 1;
  }
  return score;
}

/**
 * Pick the k examples closest to the requirements, most relevant first. Ties
 * keep the curated order (stable), so output is deterministic. When nothing
 * overlaps (an unusual brief), returns an empty list rather than noise — the
 * caller then injects no examples, exactly as a weak KB retrieval would add
 * nothing.
 */
export function selectLaunchExamples(requirements: LaunchRequirements | undefined, k = 2): LaunchExample[] {
  if (!requirements) return [];
  const reqTerms = new Set(requirementTerms(requirements));
  return LAUNCH_EXAMPLES.map((example, index) => ({ example, index, score: scoreExample(example, reqTerms) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, k))
    .map((e) => e.example);
}

/**
 * Render the selected examples as a few-shot preamble for the generation step.
 * Returns an empty string when there is nothing to show, so the caller can
 * concatenate unconditionally. The wording frames them as references to pattern
 * -match, not values to copy verbatim — the brief's real property/library,
 * delegates, and data-layer paths still win.
 */
export function launchExamplesPreamble(examples: LaunchExample[]): string {
  if (examples.length === 0) return '';
  const blocks = examples.map((example) => {
    const doc = { ruleComponents: example.ruleComponents, dataElements: example.dataElements };
    return `Example — ${example.title}:\n${JSON.stringify(doc, null, 2)}`;
  });
  return [
    'Reference examples of well-formed Launch rule components and data elements (same object-model contract you must produce — delegate_descriptor_id in "extension::type::delegate" form plus a settings object; data elements add a storage_duration). Pattern-match the brief against these; do not copy their property, library, delegates, or data-layer paths when the brief implies different ones:',
    ...blocks,
  ].join('\n\n');
}
