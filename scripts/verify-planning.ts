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

import { planUseCase, classifyUseCase, ModuleId } from '../lib/plan-builder';
import { SolutionConfig } from '../lib/types';

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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
