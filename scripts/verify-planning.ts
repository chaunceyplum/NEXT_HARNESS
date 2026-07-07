/**
 * Verification script for FEAT-002 (scope-gated planning).
 *
 * Run with: npx tsx scripts/verify-planning.ts
 *
 * Calls planUseCase()/classifyUseCase() directly against representative
 * SolutionConfig fixtures and asserts the resulting module-inclusion list
 * matches expectations — i.e. a narrow ask (e.g. "build me a schema in
 * AEP") only produces the modules genuinely implied by the request,
 * instead of cascading into Launch/CJA/AJO via synthetic defaults or
 * "empty means yes" fallbacks.
 */

import { planUseCase, classifyUseCase, ModuleId, makeRunToken } from '../lib/plan-builder';
import { SolutionConfig } from '../lib/types';
import { buildSynthesisPrompt } from '../lib/llm-planner';
import { validateSynthesizedSteps } from '../lib/tool-catalog';

function baseConfig(overrides: Partial<SolutionConfig> = {}): SolutionConfig {
  return {
    website_domain: 'example-shop.com',
    business_vertical: 'retail',
    page_types: [],
    events: [],
    segments: [],
    destinations: [],
    personalization_placements: [],
    merge_policy: '',
    sandbox_name: '',
    goals: [],
    success_metrics: [],
    confidence_score: 1,
    ...overrides,
  };
}

let failures = 0;

function assertModules(
  label: string,
  config: SolutionConfig,
  expectedIncluded: ModuleId[],
  expectedExcluded: ModuleId[]
) {
  const plan = planUseCase(config);
  const included = plan.modules.filter((m) => m.included).map((m) => m.id);
  const excluded = plan.modules.filter((m) => !m.included).map((m) => m.id);

  console.log(`\n=== ${label} ===`);
  console.log('useCase profile:', classifyUseCase(config));
  console.log(
    'modules:',
    plan.modules.map((m) => `${m.id}${m.included ? '(included, steps=' + m.stepCount + ')' : '(excluded)'}`).join(', ')
  );

  for (const id of expectedIncluded) {
    if (!included.includes(id)) {
      console.error(`  FAIL: expected module "${id}" to be included, but it was not.`);
      failures++;
    }
  }
  for (const id of expectedExcluded) {
    if (!excluded.includes(id)) {
      console.error(`  FAIL: expected module "${id}" to be EXCLUDED, but it was included.`);
      failures++;
    }
  }
  if (
    expectedIncluded.every((id) => included.includes(id)) &&
    expectedExcluded.every((id) => excluded.includes(id))
  ) {
    console.log('  PASS');
  }
}

// (a) schema-only ask: "build me a schema in AEP" — only domain + vertical
// set, everything else empty. Should ONLY include rag + aep.
const schemaOnly = baseConfig();
assertModules(
  'Fixture A: schema-only ("build me a schema in AEP")',
  schemaOnly,
  ['rag', 'aep'],
  ['launch', 'cja', 'ajo_activation', 'ajo_offers']
);

// Extra assertion: aep must not create a segment step for the schema-only
// fixture (no synthetic default segment) — only schema + dataset steps.
{
  const plan = planUseCase(schemaOnly);
  const aepSteps = plan.steps.filter((s) => s.category === 'aep');
  const segmentSteps = aepSteps.filter((s) => s.id.startsWith('aep_segment_'));
  console.log(
    `\nFixture A AEP steps: ${aepSteps.map((s) => s.id).join(', ')} (segment steps: ${segmentSteps.length})`
  );
  if (segmentSteps.length !== 0) {
    console.error('  FAIL: expected zero aep_segment_* steps for a segment-less config.');
    failures++;
  } else {
    console.log('  PASS: no synthetic segment step created.');
  }
}

// (b) full activation ask: events + segments + an email destination.
// Should include launch + cja(? only if analytics signal) + ajo_activation.
// This fixture explicitly adds a reporting goal too, so cja should also
// be included, alongside launch + ajo_activation.
const fullActivation = baseConfig({
  events: [
    {
      name: 'purchase',
      description: 'Purchase completed',
      page_types: ['checkout'],
      frequency: 'occasional',
      required_attributes: [],
      optional_attributes: [],
    },
  ],
  segments: [
    {
      name: 'high_value_customers',
      description: 'High value customers',
      segment_type: 'behavioral',
      pql_expression: 'profile.purchaseHistory.totalValue > 1000',
      destinations: [],
    },
  ],
  destinations: ['email'],
  goals: ['improve_reporting'],
});
assertModules(
  'Fixture B: full activation (events + segments + email destination + reporting goal)',
  fullActivation,
  ['launch', 'cja', 'ajo_activation'],
  []
);

// (c) analytics-only ask: segments present, no destinations, explicit
// reporting goal — cja should be included, but ajo_activation and launch
// should NOT (no events, no activation-channel destination).
const analyticsOnly = baseConfig({
  segments: [
    {
      name: 'engaged_browsers',
      description: 'Engaged browsers',
      segment_type: 'behavioral',
      pql_expression: 'profile.productViews > 3',
      destinations: [],
    },
  ],
  destinations: [],
  goals: ['improve_reporting'],
});
assertModules(
  'Fixture C: analytics-only (segments + reporting goal, no destinations/events)',
  analyticsOnly,
  ['cja'],
  ['ajo_activation', 'launch']
);

// (g) reporting-goal-only ask, zero real segments: "improve our reporting"
// with no segments/events/destinations at all. cjaModule is included
// purely via profile.analyticsFocused (not hasSegments), so
// cjaModule.build() runs with segments = []. Regression fixture for the
// semantic-review finding: the resulting cja_segment step must NOT
// reference the literal 'engaged_visitors' — that segment was never
// created anywhere in the plan since aepModule no longer synthesizes it.
const reportingGoalOnly = baseConfig({ website_domain: 'example.com', goals: ['improve_reporting'] });
assertModules(
  'Fixture G: reporting-goal-only (goals: [improve_reporting], zero segments/events/destinations)',
  reportingGoalOnly,
  ['rag', 'cja'],
  ['aep', 'launch', 'ajo_activation', 'ajo_offers']
);
{
  const plan = planUseCase(reportingGoalOnly);
  const cjaSegmentStep = plan.steps.find((s) => s.id === 'cja_segment');
  console.log(`\nFixture G cja_segment step:`, cjaSegmentStep ? cjaSegmentStep.args.name : '(not found)');
  if (!cjaSegmentStep) {
    console.error('  FAIL: expected a cja_segment step to exist for this fixture.');
    failures++;
  } else if (String(cjaSegmentStep.args.name).includes('engaged_visitors')) {
    console.error(`  FAIL: cja_segment step references orphaned 'engaged_visitors' segment name (args.name=${cjaSegmentStep.args.name}), but no real AEP segment exists in config.segments.`);
    failures++;
  } else {
    console.log("  PASS: cja_segment step does not reference the orphaned 'engaged_visitors' segment name.");
  }

  const aepSegmentSteps = plan.steps.filter((s) => s.id.startsWith('aep_segment_'));
  if (aepSegmentSteps.length !== 0) {
    console.error('  FAIL: expected zero aep_segment_* steps for this fixture (aep module is not even included).');
    failures++;
  } else {
    console.log('  PASS: no AEP segment step exists to be orphaned-referenced.');
  }
}

// (h) personalization/web-destination ask, zero real segments: reproduces
// the same orphaned-reference pattern for ajoOffersModule, which is
// included via a "web" destination or personalization placement rather
// than via hasSegments. The resulting ajo_offer step's eligibility_rules
// must not gate on a segment name that was never created.
const personalizationNoSegments = baseConfig({ website_domain: 'example.com', destinations: ['web'] });
assertModules(
  'Fixture H: personalization/web-destination-only (zero segments/events)',
  personalizationNoSegments,
  ['rag', 'ajo_offers'],
  ['aep', 'launch', 'cja', 'ajo_activation']
);
{
  const plan = planUseCase(personalizationNoSegments);
  const offerStep = plan.steps.find((s) => s.id === 'ajo_offer_0');
  console.log(`\nFixture H ajo_offer_0 eligibility_rules:`, offerStep ? JSON.stringify(offerStep.args.eligibility_rules) : '(not found)');
  if (!offerStep) {
    console.error('  FAIL: expected an ajo_offer_0 step to exist for this fixture.');
    failures++;
  } else if (JSON.stringify(offerStep.args.eligibility_rules).includes('engaged_visitors')) {
    console.error(`  FAIL: ajo_offer_0 eligibility_rules references orphaned 'engaged_visitors' segment name, but no real AEP segment exists in config.segments.`);
    failures++;
  } else {
    console.log("  PASS: ajo_offer_0 eligibility_rules does not reference the orphaned 'engaged_visitors' segment name.");
  }
}

// ── FEAT-003: LLM synthesis prompt scope-gating ─────────────────────────────
//
// We cannot make a live Anthropic call in this sandbox (no ANTHROPIC_API_KEY),
// so instead we render buildSynthesisPrompt() directly with a schema-only
// description/config and confirm the new "STAY IN SCOPE" instruction text
// (and the negative example) actually appear in the rendered prompt string
// that would be sent to the model.
{
  console.log('\n=== Fixture D: buildSynthesisPrompt() scope-limiting instruction text ===');
  const prompt = buildSynthesisPrompt('build me a schema in AEP', schemaOnly, makeRunToken());

  const mustContain = [
    'STAY IN SCOPE',
    'cja_*',
    'msb_create_ajo_*',
    'reactor_*',
    'adobe_create_schema',
  ];
  const missing = mustContain.filter((needle) => !prompt.includes(needle));
  if (missing.length > 0) {
    console.error(`  FAIL: prompt is missing expected scope-limiting text: ${missing.join(', ')}`);
    failures++;
  } else {
    console.log('  PASS: rendered prompt contains the scope-limiting instruction and negative example.');
  }
}

// ── FEAT-003: validateSynthesizedSteps() current (intentional) behavior ────
//
// validateSynthesizedSteps() only checks catalog-membership / required-params
// / well-formed refs — it deliberately does NOT reject a plan for mixing
// categories (see the NOTE comment above its definition in tool-catalog.ts),
// because it has no access to the raw description to judge relevance. These
// two checks document that current behavior: a narrowly-scoped payload
// validates OK, and a payload mixing unrelated categories ALSO validates OK.
{
  console.log('\n=== Fixture E: validateSynthesizedSteps() — narrowly-scoped payload ===');
  const narrow = validateSynthesizedSteps([
    { id: 'schema', tool: 'adobe_create_schema', args: { title: 'Profile_x', base_class: 'https://ns.adobe.com/xdm/context/profile' } },
    { id: 'dataset', tool: 'adobe_create_dataset', args: { name: 'Profile_ds_x' }, refs: { schema_ref_id: 'schema.$id' } },
  ]);
  if (!narrow.ok) {
    console.error(`  FAIL: expected narrowly-scoped payload to validate OK, got error: ${narrow.error}`);
    failures++;
  } else {
    console.log('  PASS: narrowly-scoped (aep-only) payload validates OK.');
  }

  console.log('\n=== Fixture F: validateSynthesizedSteps() — over-scoped mixed-category payload ===');
  const mixed = validateSynthesizedSteps([
    { id: 'schema', tool: 'adobe_create_schema', args: { title: 'Profile_x', base_class: 'https://ns.adobe.com/xdm/context/profile' } },
    { id: 'prop', tool: 'reactor_create_property', args: { name: 'Prop_x', platform: 'web' } },
    { id: 'dv', tool: 'cja_list_data_views', args: {} },
    { id: 'journey', tool: 'msb_create_ajo_journey', args: { name: 'Journey_x', entry_criteria: { type: 'segment', segment_name: 'vip' } } },
  ]);
  if (!mixed.ok) {
    console.error(`  FAIL (unexpected): mixed-category payload was rejected: ${mixed.error}. validateSynthesizedSteps() is documented to NOT enforce category scope; if this was intentionally changed, update this fixture's expectation.`);
    failures++;
  } else {
    console.log('  PASS (documented behavior): mixed-category payload still validates OK — scope enforcement lives in the prompt, not in validation.');
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
