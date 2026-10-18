/**
 * Brief ingestion (Phase 2): turn a free-text tagging brief into a typed,
 * validated requirements object the Launch loop/plan can act on.
 *
 * Mirrors planner.ts: generateObject + a zod v4 schema resolved through the
 * model registry, with the schema shaped to the Launch/Reactor object model
 * that agent-core.ts (LAUNCH_DOMAIN_CONTEXT) grounds the agent on — property
 * -> library -> rules{events/conditions/actions} -> data elements, each rule
 * component carrying a delegate_descriptor_id and settings, data elements
 * carrying a storage_duration, plus the data-layer references the brief
 * leans on.
 *
 * This only parses intent; it creates nothing. The deliverable boundary from
 * Phase 1 still holds — downstream code populates a library, it never
 * publishes to an environment.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel } from './model-registry';

/** The three component buckets of a Launch rule, matching the object model. */
export type RuleComponentKind = 'event' | 'condition' | 'action';

/** How long a data element persists, or null when it does not persist. */
export type StorageDuration = 'pageview' | 'session' | 'visitor' | null;

const ruleComponentSchema = z.object({
  kind: z.enum(['event', 'condition', 'action']).describe('Which part of the rule this component is: event (trigger), condition (gate), or action.'),
  delegateDescriptorId: z
    .string()
    .nullable()
    .describe('The delegate the component runs, e.g. "core::events::click". Null if the brief does not pin one down.'),
  description: z.string().max(300).describe('What this component does, in the brief\'s own terms.'),
  settings: z
    .record(z.string(), z.unknown())
    .describe('The delegate\'s configuration the brief implies, as key/value pairs. Empty object when the brief gives none.'),
});

const dataElementSchema = z.object({
  name: z.string().max(120).describe('The data element name a rule component or custom code will reference.'),
  delegateDescriptorId: z
    .string()
    .nullable()
    .describe('The data element type delegate, e.g. "core::dataElements::variable". Null if the brief does not pin one down.'),
  storageDuration: z
    .enum(['pageview', 'session', 'visitor'])
    .nullable()
    .describe('Persistence: "pageview" | "session" | "visitor", or null for no persistence.'),
  dataLayerReference: z
    .string()
    .nullable()
    .describe('The data-layer path this element reads, e.g. "digitalData.page.pageInfo.pageName". Null if not sourced from the data layer.'),
  description: z.string().max(300).describe('What value this element captures, in the brief\'s own terms.'),
});

const tagRuleSchema = z.object({
  name: z.string().max(120).describe('A short name for the rule the brief describes.'),
  description: z.string().max(300).describe('What the rule is for, in the brief\'s own terms.'),
  components: z
    .array(ruleComponentSchema)
    .describe('The rule\'s events, conditions, and actions. A rule needs at least one event; conditions and actions are optional.'),
});

const launchRequirementsSchema = z.object({
  summary: z.string().max(500).describe('One or two sentences restating what the brief asks for.'),
  target: z
    .object({
      propertyName: z.string().nullable().describe('The Launch property the work targets, or null if the brief does not name one.'),
      libraryName: z.string().nullable().describe('The library the revisions should land in, or null if the brief does not name one.'),
    })
    .describe('Where the tags go: the target property and library (the deliverable boundary — a populated library, never a publish).'),
  rules: z.array(tagRuleSchema).describe('The tags/rules to build, each with its triggers (events), conditions, and actions.'),
  dataElements: z
    .array(dataElementSchema)
    .describe('The data elements the rules and custom code need, including their data-layer references.'),
  dataLayerReferences: z
    .array(z.string().max(200))
    .describe('Distinct data-layer paths the brief relies on, e.g. "digitalData.cart.items". Empty when the brief names none.'),
  openQuestions: z
    .array(z.string().max(300))
    .describe('Anything the brief leaves ambiguous that a dev would need to resolve. Empty when the brief is complete.'),
});

/** The typed, validated requirements parsed from a free-text brief. */
export type LaunchRequirements = z.infer<typeof launchRequirementsSchema>;
export type LaunchTagRule = z.infer<typeof tagRuleSchema>;
export type LaunchRuleComponent = z.infer<typeof ruleComponentSchema>;
export type LaunchDataElement = z.infer<typeof dataElementSchema>;

const BRIEF_SYSTEM = [
  'You parse a free-text Adobe Launch (Reactor) tagging brief into a structured requirements object a MarTech engineering agent will build from.',
  'Ground everything in the Launch object model: a property holds libraries, rules, and data elements; a rule = events (triggers) + conditions + actions, each a component with a delegate_descriptor_id (e.g. "core::events::click") and a settings object; a data element has a type delegate (e.g. "core::dataElements::variable"), a settings object, and a storage_duration ("pageview" | "session" | "visitor", or none).',
  'Capture only what the brief states or clearly implies. Do not invent properties, libraries, delegates, or data-layer paths the brief does not support — use null and record the gap in openQuestions instead of guessing.',
  'You are only extracting requirements. You are not creating anything and you never publish to an environment.',
].join('\n');

/**
 * Parse a free-text brief into a validated {@link LaunchRequirements} object.
 *
 * @param brief the raw brief text.
 * @param modelKey registry key for the model to use (defaults to the registry default).
 * @param context optional extra context (deployment defaults, known property/library) to steer parsing.
 */
export async function parseLaunchBrief(brief: string, modelKey?: string, context?: string): Promise<LaunchRequirements> {
  const { object } = await generateObject({
    model: resolveModel(modelKey),
    schema: launchRequirementsSchema,
    system: BRIEF_SYSTEM,
    prompt: `${context ? `${context}\n\n` : ''}Brief:\n${brief}`,
  });
  return object;
}

export { launchRequirementsSchema };
