/**
 * Launch plan seed + Launch-mode tool RAG (Phase 3): the grounding template a
 * Launch-tagging run executes, and the glue that lets the Phase 2 requirements
 * object (launch-brief.ts) steer tool selection.
 *
 * Nothing new is invented on the planning side — the seed is an ordinary
 * {@link Plan} normalised through planner.ts's own {@link normalisePlan}, so it
 * flows through PlanTracker / planPreamble / update_plan / revise_plan exactly
 * like an LLM-produced plan. The template just fixes the ordered backbone a
 * tagging job always follows:
 *
 *   read the target property's extensions + existing data elements
 *   -> map each tag type to its delegate, from the planning-stage KB excerpts
 *   -> generate the rule/data-element components
 *   -> validate them against the object model
 *   -> create/populate the library
 *
 * Deliverable boundary (Phase 1): the plan stops at a populated library. There
 * is no publish/build step — the run never transitions a library to an
 * environment.
 */

import { normalisePlan, MAX_PLAN_STEPS, type Plan } from './planner';
import type { LaunchRequirements } from './launch-brief';

/**
 * Core Reactor/Launch read + write tools a Launch-tagging run always needs.
 * (Its knowledge grounding is retrieved at planning — planning-retrieval.ts —
 * not searched by the model.) Added to the always-on set (on top
 * of ALWAYS_ON_TOOLS) in Launch mode so the shortlist never has to win these
 * on embedding similarity alone — a brief that talks about "add-to-cart
 * clicks" doesn't reliably rank "reactor_create_data_element" highly, which
 * previously left the agent able to read a property but not populate it.
 *
 * Matches the ALWAYS_ON_TOOLS contract in agent-core.ts: these are filtered
 * against the live MCP catalog in agent.ts, so a name the connected server
 * doesn't expose is silently dropped rather than erroring. Names follow the
 * Reactor REST resource model (properties -> extensions / data elements /
 * rules{+ rule components} -> libraries). No build/transition tool is listed:
 * the deliverable stops at a populated library.
 */
export const LAUNCH_ALWAYS_ON_TOOLS = [
  // Read the target property's current state before changing it.
  'reactor_list_extensions',
  'reactor_list_data_elements',
  'reactor_list_rules',
  'reactor_get_property',
  // Create/populate the library and its resources (populate, never publish).
  'reactor_create_data_element',
  'reactor_update_data_element',
  'reactor_create_rule',
  'reactor_update_rule',
  'reactor_create_rule_component',
  'reactor_update_rule_component',
  'reactor_create_library',
  'reactor_add_resources_to_library',
  'reactor_install_extension',
];

/**
 * The publish pipeline tools a Launch run only needs when it was started with
 * a publishTarget: read the environment's stage (so the production block has
 * server truth), build the library, poll the build, and transition it. Kept
 * OFF the non-publish list so a library-only run's always-on set — and the
 * tools the model can even reach — is unchanged.
 */
export const LAUNCH_PUBLISH_ALWAYS_ON_TOOLS = [
  // Read the target environment's stage from server truth (production block).
  'reactor_get_environment',
  'reactor_list_environments',
  // Read the library's bound environment and state (the gate checks both).
  'reactor_get_library',
  // Build → poll → transition the populated library (dev/staging only).
  'reactor_build_library',
  'reactor_get_build',
  'reactor_transition_library',
];

/**
 * The always-on Reactor/Launch tools for a Launch run. Non-publish runs get
 * exactly {@link LAUNCH_ALWAYS_ON_TOOLS} (byte-identical to before); a publish
 * run also gets {@link LAUNCH_PUBLISH_ALWAYS_ON_TOOLS} so it can actually reach
 * the build→poll→transition pipeline.
 */
export function launchAlwaysOnTools(publishEnabled: boolean): string[] {
  return publishEnabled ? [...LAUNCH_ALWAYS_ON_TOOLS, ...LAUNCH_PUBLISH_ALWAYS_ON_TOOLS] : LAUNCH_ALWAYS_ON_TOOLS;
}

/** The fixed, ordered backbone every Launch-tagging job follows. */
interface SeedStep {
  description: string;
  tool: string | null;
  expectedOutput: string;
  /**
   * 1-based positions, within this seed list, of the earlier steps this step
   * needs. Encodes the real dependency DAG (Req 9.2) rather than a strict
   * chain: the two property reads are independent, so a coordinator can run
   * them in parallel, while grounding, generation, validation and library
   * population stay ordered after them.
   */
  dependsOn: number[];
}

function seedSteps(requirements?: LaunchRequirements, publishEnabled = false): SeedStep[] {
  const propertyName = requirements?.target.propertyName;
  const libraryName = requirements?.target.libraryName;
  const propertyRef = propertyName ? `property "${propertyName}"` : 'the target property';
  const libraryRef = libraryName ? `library "${libraryName}"` : 'the target library';
  const tagCount = requirements?.rules.length;
  const dataElementCount = requirements?.dataElements.length;

  // Seed ids are 1-based positions in this list. The two reads (1, 2) have no
  // dependencies and no path between them, so they can run in parallel;
  // grounding (3) needs both reads; generation (4) needs grounding; validation
  // (5) needs the generated components and the reads it validates against;
  // populating the library (6) needs the validated set.
  const base: SeedStep[] = [
    {
      description: `Read ${propertyRef}'s installed extensions.`,
      tool: 'reactor_list_extensions',
      expectedOutput: 'the installed extensions and their delegate_descriptor_ids',
      dependsOn: [],
    },
    {
      description: `Read ${propertyRef}'s existing data elements.`,
      tool: 'reactor_list_data_elements',
      expectedOutput: 'the data elements already present (so none are recreated)',
      dependsOn: [],
    },
    {
      description:
        `Ground each tag type${tagCount ? ` (${tagCount} rule(s))` : ''} in the knowledge-base excerpts and reference examples provided: ` +
        'pick the delegate and settings for every event/condition/action and data element the brief needs.',
      tool: null,
      expectedOutput: 'the delegate_descriptor_id and settings shape for each component, citing the KB excerpts used',
      dependsOn: [1, 2],
    },
    {
      description:
        `Generate the rule components and data element definitions${dataElementCount ? ` (${dataElementCount} data element(s))` : ''} ` +
        'from the grounded delegates and the brief requirements.',
      tool: null,
      expectedOutput: 'each rule and data element expressed as delegate_descriptor_id + settings',
      dependsOn: [3],
    },
    {
      description:
        'Validate the generated components against the object model: every delegate_descriptor_id comes from an ' +
        'installed extension, and every referenced data element exists or is created in this library.',
      tool: null,
      expectedOutput: 'a validated set with no missing extensions or data-element references',
      dependsOn: [1, 2, 4],
    },
    {
      description: `Create/populate ${libraryRef} with the validated rules and data elements.`,
      tool: 'reactor_create_library',
      expectedOutput: publishEnabled
        ? 'the populated library id, ready to build and publish to dev/staging'
        : 'the populated library id (deliverable boundary — do not publish)',
      dependsOn: [5],
    },
  ];

  if (!publishEnabled) return base;

  // Publish runs continue past the populated library: build → poll the build
  // until it succeeds → transition to the named dev/staging environment. Never
  // a production transition (the gate refuses it in code). Two steps keep the
  // whole backbone within MAX_PLAN_STEPS.
  base.push(
    {
      description: `Build ${libraryRef} and poll the build until its status is "succeeded" (fix components and rebuild if it fails).`,
      tool: 'reactor_build_library',
      expectedOutput: 'a build whose status reaches "succeeded" (no transition on a failed build)',
      dependsOn: [6], // the populated library
    },
    {
      description:
        'If the target is staging, transition the built library with action "submit" (and build again); a ' +
        'development target is already live after the build. Never "approve" or "publish" — that is production.',
      tool: 'reactor_transition_library',
      expectedOutput: 'the library published to the dev/staging environment',
      dependsOn: [7], // the successful build
    }
  );
  return base;
}

/**
 * Build the seeded Launch plan as a normalised {@link Plan}, deterministically
 * (no model call). The goal and per-step wording are specialised from the
 * Phase 2 requirements when they are available, so the plan the executor runs
 * names the real property/library/tag counts instead of placeholders.
 *
 * Runs through planner.ts's {@link normalisePlan}, so it is renumbered from 1,
 * starts every step pending, and is capped at MAX_PLAN_STEPS exactly like a
 * generated plan — PlanTracker/planPreamble treat it identically.
 *
 * `publishEnabled` (a run started with a publishTarget) appends the
 * build→poll→transition-to-dev/staging backbone after the populate step, and
 * never a production transition. Omit it (or pass false) for the historical
 * library-only backbone, which is byte-identical to before.
 */
export function seedLaunchPlan(requirements?: LaunchRequirements, publishEnabled = false): Plan {
  const steps = seedSteps(requirements, publishEnabled).slice(0, MAX_PLAN_STEPS);
  const goal =
    requirements?.summary ??
    (publishEnabled
      ? 'Build the briefed Launch tags, populate a library, and publish it to the dev/staging environment.'
      : 'Build the briefed Launch tags and populate a library for devs to test (no publish).');
  return normalisePlan(
    {
      goal: goal.slice(0, 300),
      steps: steps.map((s, i) => ({
        id: i + 1,
        description: s.description.slice(0, 200),
        tool: s.tool,
        expectedOutput: s.expectedOutput.slice(0, 200),
        dependsOn: s.dependsOn, // the backbone's real DAG (Req 9.2)
      })),
    },
    1
  );
}

/**
 * Expand the raw request into a tool-shortlist query enriched with the parsed
 * requirements, so the semantic shortlist (tool-retrieval.ts shortlistTools)
 * ranks the Reactor/Launch tools the job actually needs. The requirements add
 * the distinctive terms a free-text brief often buries — delegate ids, data
 * element and data-layer references, the target property/library — which the
 * raw brief alone may not surface.
 *
 * Falls back to the raw input unchanged when there are no requirements.
 */
export function launchShortlistQuery(userInput: string, requirements?: LaunchRequirements): string {
  if (!requirements) return userInput;

  const terms: string[] = ['Adobe Launch Reactor tags library property extension rule data element'];

  if (requirements.target.propertyName) terms.push(`property ${requirements.target.propertyName}`);
  if (requirements.target.libraryName) terms.push(`library ${requirements.target.libraryName}`);

  for (const rule of requirements.rules) {
    terms.push(rule.name);
    for (const component of rule.components) {
      terms.push(component.kind);
      if (component.delegateDescriptorId) terms.push(component.delegateDescriptorId);
    }
  }

  for (const element of requirements.dataElements) {
    terms.push(element.name);
    if (element.delegateDescriptorId) terms.push(element.delegateDescriptorId);
    if (element.dataLayerReference) terms.push(element.dataLayerReference);
  }

  terms.push(...requirements.dataLayerReferences);

  return [userInput, terms.join(' ')].join('\n');
}
