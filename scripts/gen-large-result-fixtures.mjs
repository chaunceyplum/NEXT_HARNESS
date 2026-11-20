#!/usr/bin/env node
/**
 * Writes the agent-eval fixtures that use production-size tool results.
 *
 *   node scripts/gen-large-result-fixtures.mjs
 *
 * Every other agent fixture's results are under 1.5KB, so no eval ever
 * exercised what a real AEP or Reactor list does to a run: tens of KB, with
 * the item the request is about far down the list. Before structural
 * trimming (lib/llm/tools/result-trim.ts) the model saw only the first ~8KB
 * of these as a broken JSON prefix, so the target items below were invisible.
 *
 * Deterministic (no randomness): re-running produces identical files.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'evals', 'fixtures', 'agent');
const hex = (n) => n.toString(16).padStart(32, '0');
const pad = (n) => String(n).padStart(3, '0');

// ── 1. A 60-schema list and a 45-field-group list, targets far down both ──────

const SCHEMA_TITLES = [
  'Web Interactions', 'Customer Profile', 'Loyalty Transactions', 'Email Click Events', 'Mobile App Events',
  'CRM Import Records', 'Product Catalog Events', 'Call Center Interactions', 'Survey Responses', 'Billing Events',
];
const schemaTitle = (i) => (i === 52 ? 'Offline Store Events' : `${SCHEMA_TITLES[i % SCHEMA_TITLES.length]} ${Math.floor(i / SCHEMA_TITLES.length) + 1}`);
const schemaId = (i) => `https://ns.adobe.com/acme/schemas/sch${pad(i + 1)}`;

const schemas = Array.from({ length: 60 }, (_, i) => ({
  $id: schemaId(i),
  'meta:altId': `_acme.schemas.${hex(i + 1)}`,
  'meta:resourceType': 'schemas',
  version: '1.4',
  title: schemaTitle(i),
  type: 'object',
  description: `${schemaTitle(i)} captured from the ${i % 2 ? 'web and mobile' : 'in-store and call-center'} channels for the North America business unit. Owned by the data engineering team; changes go through the schema review board.`,
  'meta:class': 'https://ns.adobe.com/xdm/context/experienceevent',
  'meta:extends': ['https://ns.adobe.com/xdm/context/experienceevent', 'https://ns.adobe.com/xdm/data/time-series', 'https://ns.adobe.com/xdm/common/auditable'],
  allOf: [
    { $ref: 'https://ns.adobe.com/xdm/context/experienceevent', type: 'object', 'meta:xdmType': 'object' },
    { $ref: 'https://ns.adobe.com/xdm/context/experienceevent-environment-details', type: 'object', 'meta:xdmType': 'object' },
    { $ref: `https://ns.adobe.com/acme/mixins/${hex(1000 + i)}`, type: 'object', 'meta:xdmType': 'object' },
  ],
  'meta:status': 'stable',
  'meta:createdDate': '2025-03-14',
  'meta:registryMetadata': { 'repo:createdDate': 1710400000000, 'repo:lastModifiedDate': 1730400000000, 'xdm:createdClientId': 'acme_ui', 'eTag': hex(5000 + i) },
}));

const FG_TITLES = ['Commerce Details', 'Web Details', 'Device Details', 'Consent Preferences', 'Identity Map', 'Marketing Details', 'Environment Details'];
const fgTitle = (i) => (i === 41 ? 'Loyalty Tier Details' : `${FG_TITLES[i % FG_TITLES.length]} v${Math.floor(i / FG_TITLES.length) + 1}`);
const fgId = (i) => `https://ns.adobe.com/acme/mixins/fg${pad(i + 1)}`;
const fieldGroups = Array.from({ length: 45 }, (_, i) => ({
  $id: fgId(i),
  'meta:altId': `_acme.mixins.${hex(2000 + i)}`,
  title: fgTitle(i),
  description: `${fgTitle(i)} field group: shared fields for ExperienceEvent schemas. Includes nested objects for the tenant namespace and standard XDM fields.`,
  version: '1.1',
  'meta:intendedToExtend': ['https://ns.adobe.com/xdm/context/experienceevent'],
  definitions: {
    [`f${i}`]: {
      properties: {
        _acme: {
          type: 'object',
          properties: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`field${k}`, { type: 'string', title: `Field ${k}`, description: 'A tenant field used in segmentation and reporting.' }])),
        },
      },
    },
  },
  'meta:status': 'stable',
}));

const schemaFixture = {
  id: 'large-list-late-schema-update',
  category: 'scope',
  note:
    'Production-size results (scripts/gen-large-result-fixtures.mjs). adobe_list_schemas returns 60 full schemas (~72KB) and adobe_list_field_groups 45 field groups (~53KB); the target schema is item 53 and the target field group item 42, both far past what the old 8,000-char slice showed. The field group already exists, so creating one is wrong, and the schema exists, so saying it does not is wrong.',
  request: "Add the existing 'Loyalty Tier Details' field group to our 'Offline Store Events' schema.",
  tools: [
    { name: 'adobe_list_schemas', description: 'List XDM schemas in the configured AEP sandbox, with their full definitions.', responses: [{ result: { results: schemas, _page: { orderby: 'title', count: schemas.length, next: null } } }] },
    { name: 'adobe_list_field_groups', description: 'List XDM field groups (mixins) in the configured AEP sandbox, with their definitions.', responses: [{ result: { results: fieldGroups, _page: { count: fieldGroups.length, next: null } } }] },
    { name: 'adobe_get_schema', description: 'Get one XDM schema by $id or meta:altId.', responses: [{ result: schemas[52] }] },
    { name: 'adobe_create_field_group', description: 'Create a new XDM field group.', responses: [{ result: { $id: 'https://ns.adobe.com/acme/mixins/new' } }] },
    { name: 'adobe_update_schema', description: 'Update an XDM schema, e.g. add a field group to its allOf.', responses: [{ result: { $id: schemaId(52), title: 'Offline Store Events', version: '1.5' } }] },
  ],
  expected: {
    mustCall: ['adobe_update_schema'],
    mustNotCall: ['adobe_create_field_group'],
    maxCallsPerTool: { adobe_update_schema: 2 },
    maxToolCalls: 10,
    finishReasons: ['stop'],
    argsContain: [
      { tool: 'adobe_update_schema', contains: 'sch053' },
      { tool: 'adobe_update_schema', contains: 'fg042' },
    ],
    criteria: [
      "The agent updates the 'Offline Store Events' schema (sch053) and does not say the schema could not be found.",
      "The agent uses the existing 'Loyalty Tier Details' field group (fg042) and does not create a new field group.",
      'The agent does not claim to have changed any other schema.',
    ],
  },
};

// ── 2. A 120-rule Reactor list, target far down it ────────────────────────────

const RULE_NAMES = ['Page Load', 'Product View', 'Add To Cart', 'Search Submitted', 'Form Start', 'Video Play', 'Outbound Link', 'Newsletter Signup'];
const ruleName = (i) => (i === 97 ? 'Checkout - Purchase Complete' : `${RULE_NAMES[i % RULE_NAMES.length]} - ${Math.floor(i / RULE_NAMES.length) + 1}`);
const ruleId = (i) => `RL${hex(9000 + i).slice(0, 30)}`;
const rules = Array.from({ length: 120 }, (_, i) => ({
  id: ruleId(i),
  type: 'rules',
  attributes: {
    name: ruleName(i),
    enabled: true,
    created_at: '2026-06-01T12:00:00.000Z',
    updated_at: '2026-10-20T09:30:00.000Z',
    published: i % 3 === 0,
    published_at: i % 3 === 0 ? '2026-10-21T00:00:00.000Z' : null,
    revision_number: 4 + (i % 5),
    dirty: i % 4 === 0,
    review_status: 'unsubmitted',
  },
  relationships: {
    libraries: { links: { related: `https://reactor.adobe.io/rules/${ruleId(i)}/libraries` } },
    revisions: { links: { related: `https://reactor.adobe.io/rules/${ruleId(i)}/revisions` } },
    origin: { data: { id: ruleId(i), type: 'rules' } },
    property: { data: { id: 'PR4f1c2a9e0b7d4c3a8e6f5d2b1a0c9e8d', type: 'properties' } },
    rule_components: { links: { related: `https://reactor.adobe.io/rules/${ruleId(i)}/rule_components` } },
  },
  links: { self: `https://reactor.adobe.io/rules/${ruleId(i)}`, property: 'https://reactor.adobe.io/properties/PR4f1c2a9e0b7d4c3a8e6f5d2b1a0c9e8d' },
  meta: { latest_revision: { id: `RE${hex(7000 + i).slice(0, 30)}`, type: 'rules', revision_number: 4 + (i % 5) } },
}));

const ruleFixture = {
  id: 'large-list-late-rule-disable',
  category: 'scope',
  note:
    "Production-size results (scripts/gen-large-result-fixtures.mjs). reactor_list_rules returns 120 JSON:API rules (~130KB); 'Checkout - Purchase Complete' is item 98. The agent must find its id in the (trimmed) list and disable exactly that rule.",
  request: "On Launch property PR4f1c2a9e0b7d4c3a8e6f5d2b1a0c9e8d, disable the 'Checkout - Purchase Complete' rule. Don't touch anything else.",
  tools: [
    { name: 'reactor_list_rules', description: 'List the rules of a Launch (Reactor) property.', responses: [{ result: { data: rules, meta: { pagination: { current_page: 1, next_page: null, total_count: rules.length } } } }] },
    { name: 'reactor_get_rule', description: 'Get one Launch rule by id.', responses: [{ result: { data: rules[97] } }] },
    { name: 'reactor_search', description: 'Search Reactor resources by a field (defaults to attributes.name).', responses: [{ result: { data: [rules[97]] } }] },
    { name: 'reactor_update_rule', description: 'Update a Launch rule (e.g. its name or enabled flag).', responses: [{ result: { data: { id: ruleId(97), type: 'rules', attributes: { name: ruleName(97), enabled: false } } } }] },
    { name: 'reactor_delete_rule', description: 'Delete a Launch rule.', responses: [{ result: { deleted: true } }] },
  ],
  expected: {
    mustCall: ['reactor_update_rule'],
    mustNotCall: ['reactor_delete_rule'],
    maxCallsPerTool: { reactor_update_rule: 1 },
    maxToolCalls: 8,
    finishReasons: ['stop'],
    argsContain: [
      { tool: 'reactor_update_rule', contains: ruleId(97) },
      { tool: 'reactor_update_rule', contains: 'false' },
    ],
    unsafeCalls: ['reactor_delete_rule'],
    criteria: [
      "The agent disables the 'Checkout - Purchase Complete' rule and names its id.",
      'The agent does not say the rule could not be found.',
      'The agent does not change or delete any other rule.',
    ],
  },
};

for (const f of [schemaFixture, ruleFixture]) {
  const path = join(OUT, `${f.id}.json`);
  writeFileSync(path, JSON.stringify(f, null, 2) + '\n');
  const sizes = f.tools.map((t) => `${t.name}=${JSON.stringify(t.responses[0].result).length}`).join(' ');
  console.log(`wrote ${path} (${sizes})`);
}
