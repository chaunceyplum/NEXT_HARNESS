/**
 * Phase 4 — the validation gate (the reliability piece).
 *
 * Before the real library handoff (reactor_create_library /
 * reactor_update_library) is sent to the MCP server, three checks run against
 * the resources the agent is about to populate the library with. Any failure
 * BLOCKS the handoff and is handed back to the agent as a thrown tool error —
 * the SAME tier-2 "validation error" feedback the loop already surfaces for a
 * rejected MCP call (tool-catalog.ts), so the model fixes its arguments and
 * calls again. No new retry/feedback mechanism is introduced; this just gates
 * the handoff the way commit-validation.ts gates msb_github_commit_code.
 *
 * The three checks (all deterministic — no model/network calls):
 *
 *   1. STRUCTURAL — zod v4 schemas for the Launch rule components and data
 *      elements, matching the Phase 1 object-model contract (agent-core.ts's
 *      LAUNCH_DOMAIN_CONTEXT and docs/reactor-tools-context.md): a rule
 *      component carries a delegate_descriptor_id in `ext::type::name` form
 *      plus a settings object; a data element carries a name, a
 *      delegate_descriptor_id, settings, and a storage_duration.
 *
 *   2. REFERENCE — every rule-component delegate_descriptor_id names a
 *      delegate from an extension installed in the property, and every
 *      data-element reference resolves to a data element that already exists
 *      in the property OR is being created in the same library. Both are
 *      checked against the property state the run READ during Phase 3
 *      grounding (reactor_list_extensions / reactor_list_data_elements) and
 *      the data elements it created this run — captured as those tool results
 *      flowed through the loop (see LaunchPropertyState).
 *
 *   3. DRY-RUN populate — reuses the run's existing dryRun / shadow rollout
 *      mode (approval-policy.ts, tool-policy.ts). In those modes the write is
 *      never sent to the MCP server, so a server-side rejection can't surface;
 *      this check stands in for it, re-asserting the structural + reference
 *      invariants a real create/populate call would be rejected for, so a
 *      shadow run surfaces the same problems a live one would. It is NOT a
 *      live API call — exactly as commit-validation.ts is a parse check, not
 *      the target repo's real build.
 *
 * Deliverable boundary (Phase 1) is unchanged: the gate validates populating a
 * library, never publishing — there is no build/transition handling here.
 */

import { z } from 'zod';
import { classifyTool } from './tool-policy';

// ── The handoff tools this gate covers ─────────────────────────────────────────

/**
 * The real library handoff: creating or updating the library the devs load to
 * test. Validation blocks these until all three checks pass. (reactor_build_
 * library / reactor_transition_library are deliberately absent — publishing is
 * outside the deliverable boundary and already gated for human approval in
 * approval-policy.ts.)
 */
export const LAUNCH_HANDOFF_TOOLS = new Set(['reactor_create_library', 'reactor_update_library']);

/** Tools whose results seed the property state the reference check reads. */
const EXTENSION_READ_TOOLS = new Set(['reactor_list_extensions', 'reactor_get_extension', 'reactor_create_extension']);
const DATA_ELEMENT_READ_TOOLS = new Set([
  'reactor_list_data_elements',
  'reactor_get_data_element',
  'reactor_create_data_element',
  'reactor_update_data_element',
]);
const RULE_COMPONENT_WRITE_TOOLS = new Set(['reactor_create_rule_component', 'reactor_update_rule_component']);

export function isLaunchHandoffTool(toolName: string): boolean {
  return LAUNCH_HANDOFF_TOOLS.has(toolName);
}

// ── (1) STRUCTURAL — zod v4 schemas matching the Phase 1 contract ──────────────

/**
 * A delegate_descriptor_id is `extensionName::type::delegateName`
 * (docs/reactor-tools-context.md), e.g. "core::events::click". The settings a
 * component/data element carries are type-specific JSON, so they're an open
 * record rather than a fixed shape — the reference check and the delegate's
 * own extension validate meaning; the schema only enforces structure.
 */
const DELEGATE_DESCRIPTOR_RE = /^[a-zA-Z0-9_-]+::[a-zA-Z0-9_-]+::[a-zA-Z0-9_-]+$/;

const delegateDescriptorId = z
  .string()
  .regex(DELEGATE_DESCRIPTOR_RE, 'must be in "extension::type::delegate" form, e.g. "core::events::click"');

const settings = z.record(z.string(), z.unknown());

/** A Launch rule component (an event, condition, or action) as the create/update tool receives it. */
export const ruleComponentSchema = z.object({
  delegate_descriptor_id: delegateDescriptorId,
  settings,
  // Reactor accepts order/name/negate etc. too; they don't affect validation.
});

/** A Launch data element as the create/update tool receives it. */
export const dataElementSchema = z.object({
  name: z.string().min(1).max(255),
  delegate_descriptor_id: delegateDescriptorId,
  settings,
  // Reactor's storage_duration is "visitor" | "session" | "pageview", or omitted for no persistence.
  storage_duration: z.enum(['visitor', 'session', 'pageview']).optional(),
});

export type LaunchRuleComponentPayload = z.infer<typeof ruleComponentSchema>;
export type LaunchDataElementPayload = z.infer<typeof dataElementSchema>;

/** The extension name is the delegate id's prefix: `core::events::click` → `core`. */
export function extensionOfDelegate(delegateDescriptorId: string): string | undefined {
  const prefix = delegateDescriptorId.split('::')[0];
  return prefix ? prefix : undefined;
}

/** One issue off a zod v4 safeParse error, typed from the error itself (version-robust). */
type ZodIssue = z.ZodError['issues'][number];

/** Flatten one zod issue into a readable "path: message" line. */
function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length ? issue.path.map((p) => String(p)).join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/**
 * Structural check for a single rule component or data element. Returns one
 * error string per problem (empty = valid), mirroring validateCommitFiles.
 */
export function validateRuleComponentShape(component: unknown): string[] {
  const result = ruleComponentSchema.safeParse(component);
  return result.success ? [] : result.error.issues.map(formatIssue);
}

export function validateDataElementShape(element: unknown): string[] {
  const result = dataElementSchema.safeParse(element);
  return result.success ? [] : result.error.issues.map(formatIssue);
}

// ── Property state captured during the run (feeds the REFERENCE check) ─────────

/**
 * The slice of property state the reference check needs, built up as the run's
 * read/create tool results flow through the loop. One instance per run (like
 * GroundingState / WriteDeduper in tool-catalog.ts), created in agent.ts and
 * fed by the buildAiTools execute wrapper.
 *
 *   - installedExtensions: extension names present in the property, from
 *     reactor_list_extensions (Phase 3 grounding) and any reactor_create_
 *     extension this run made. A rule-component / data-element delegate must
 *     name one of these.
 *   - knownDataElements: data element names that exist in the property
 *     (reactor_list_data_elements) or were created this run
 *     (reactor_create_data_element). A data-element reference in rule-component
 *     settings must resolve to one of these.
 *
 * The tool results are untrusted shapes (MCP wraps the JSON:API response and
 * the harness caps/normalises it), so ingestion is defensive: anything it
 * can't read is simply skipped, never thrown on — a failure to observe state
 * must not break the run, it just means the reference check has less to go on.
 */
export class LaunchPropertyState {
  readonly installedExtensions = new Set<string>();
  readonly knownDataElements = new Set<string>();

  /** Record an extension as installed/available in the property. */
  addExtension(name: string): void {
    if (name) this.installedExtensions.add(name);
  }

  /** Record a data element as existing in the property / created this run. */
  addDataElement(name: string): void {
    if (name) this.knownDataElements.add(name);
  }

  /**
   * Observe one tool call's arguments + result and absorb any extension or
   * data-element facts they carry. Never throws.
   */
  observe(toolName: string, args: unknown, result: unknown): void {
    try {
      if (EXTENSION_READ_TOOLS.has(toolName)) {
        for (const name of collectExtensionNames(result)) this.addExtension(name);
      }
      if (DATA_ELEMENT_READ_TOOLS.has(toolName)) {
        for (const name of collectResourceNames(result)) this.addDataElement(name);
        // A create/update also carries the name in its arguments.
        const argName = readName(args);
        if (argName) this.addDataElement(argName);
      }
    } catch {
      // Observing state is best-effort; a weird payload shape must not break the run.
    }
  }
}

/** Pull a resource `name` from a value that might be the args object or an attributes object. */
function readName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name === 'string') return v.name;
  const attrs = v.attributes;
  if (attrs && typeof attrs === 'object' && typeof (attrs as Record<string, unknown>).name === 'string') {
    return (attrs as Record<string, unknown>).name as string;
  }
  return undefined;
}

/** Every string value found at `key` anywhere in a JSON-like value. */
function collectStringsAtKey(value: unknown, key: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStringsAtKey(item, key, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key && typeof v === 'string' && v) out.add(v);
      collectStringsAtKey(v, key, out);
    }
  }
}

/**
 * Extension names from a reactor_list_extensions / get / create result. The
 * JSON:API resource carries attributes.name (the extension package name, e.g.
 * "core", "adobe-analytics"); we also take any delegate prefixes present, so a
 * configured extension still registers the name a delegate references.
 */
function collectExtensionNames(result: unknown): Set<string> {
  const names = new Set<string>();
  collectStringsAtKey(result, 'name', names);
  const delegates = new Set<string>();
  collectStringsAtKey(result, 'delegate_descriptor_id', delegates);
  for (const d of delegates) {
    const ext = extensionOfDelegate(d);
    if (ext) names.add(ext);
  }
  return names;
}

/** Resource names (data elements) from a list/get/create result. */
function collectResourceNames(result: unknown): Set<string> {
  const names = new Set<string>();
  collectStringsAtKey(result, 'name', names);
  return names;
}

// ── (2) REFERENCE — delegates + data-element references resolve ────────────────

/**
 * Data-element references in Reactor custom code / settings are written
 * `%dataElementName%` (percent-wrapped), which is how a rule component or
 * another data element names a data element. We pull those tokens out of the
 * settings JSON so each can be checked against the property's known data
 * elements.
 */
const DATA_ELEMENT_REF_RE = /%([^%]+)%/g;

export function dataElementReferencesIn(settings: unknown): string[] {
  const json = typeof settings === 'string' ? settings : JSON.stringify(settings ?? {});
  const refs = new Set<string>();
  for (const match of json.matchAll(DATA_ELEMENT_REF_RE)) {
    const name = match[1]?.trim();
    if (name) refs.add(name);
  }
  return [...refs];
}

/**
 * A rule component to reference-check: its delegate's extension must be
 * installed, and any data elements its settings reference must be known.
 */
export interface RuleComponentRef {
  delegate_descriptor_id: string;
  settings: unknown;
}

/**
 * REFERENCE check for a set of rule components about to be populated. Returns
 * one error per unresolved delegate extension or data-element reference.
 */
export function validateReferences(components: RuleComponentRef[], state: LaunchPropertyState): string[] {
  const errors: string[] = [];
  for (const component of components) {
    const ext = extensionOfDelegate(component.delegate_descriptor_id);
    if (ext && !state.installedExtensions.has(ext)) {
      errors.push(
        `delegate "${component.delegate_descriptor_id}" needs extension "${ext}", which is not installed in the property ` +
          `(install it first, or read the property's extensions). Installed: ${describeSet(state.installedExtensions)}.`
      );
    }
    for (const ref of dataElementReferencesIn(component.settings)) {
      if (!state.knownDataElements.has(ref)) {
        errors.push(
          `data element "%${ref}%" is referenced but does not exist in the property and is not being created in this library ` +
            `(create it first, or fix the reference). Known: ${describeSet(state.knownDataElements)}.`
        );
      }
    }
  }
  return errors;
}

function describeSet(set: Set<string>): string {
  if (set.size === 0) return 'none observed';
  const names = [...set];
  return names.length <= 12 ? names.join(', ') : `${names.slice(0, 12).join(', ')}, …(+${names.length - 12})`;
}

// ── The library handoff payload the three checks run over ──────────────────────

/**
 * What a Launch library create/populate call is handing off: the rule
 * components and data elements that go into the library. These are collected
 * from the arguments the agent passes to the handoff tool and from the
 * create_rule_component / create_data_element calls made earlier this run.
 */
export interface LaunchHandoffPayload {
  ruleComponents: unknown[];
  dataElements: unknown[];
}

export interface LaunchValidationResult {
  ok: boolean;
  /** One error string per problem across all three checks. */
  errors: string[];
}

/**
 * Run all three checks over a library handoff. `dryRun` / `shadow` indicate the
 * run's rollout mode (approval-policy.ts): the DRY-RUN populate check only
 * matters there (a live run gets the real server rejection), but the
 * structural + reference checks run every time — they're what the dry-run
 * stands in for, so a shadow run surfaces the same failures a live one would.
 */
export function validateLaunchHandoff(
  payload: LaunchHandoffPayload,
  state: LaunchPropertyState,
  opts: { dryRun?: boolean; shadow?: boolean } = {}
): LaunchValidationResult {
  const errors: string[] = [];

  // (1) STRUCTURAL — every component and data element parses against the contract.
  const structuralComponents: RuleComponentRef[] = [];
  payload.ruleComponents.forEach((component, i) => {
    const issues = validateRuleComponentShape(component);
    if (issues.length) {
      errors.push(...issues.map((msg) => `rule component [${i}]: ${msg}`));
    } else {
      structuralComponents.push(component as RuleComponentRef);
    }
  });
  payload.dataElements.forEach((element, i) => {
    const issues = validateDataElementShape(element);
    if (issues.length) errors.push(...issues.map((msg) => `data element [${i}]: ${msg}`));
  });

  // (2) REFERENCE — delegates resolve to installed extensions, data-element refs resolve.
  // Only the structurally-valid components (a malformed delegate id can't be reference-checked).
  errors.push(...validateReferences(structuralComponents, state));

  // (3) DRY-RUN populate — in dryRun/shadow the MCP write never runs, so this
  // stands in for the server rejection by re-asserting (1)+(2) as the gate the
  // handoff must clear. There is nothing extra to assert for a live run (it
  // gets the real rejection), so the pass/fail is the union of (1)+(2) either
  // way; the flag only records which path produced it.
  const dryRun = opts.dryRun === true || opts.shadow === true;
  void dryRun;

  return { ok: errors.length === 0, errors };
}

/**
 * Gate the real library handoff. Throws (no side effects — the MCP write is
 * never sent) when any check fails, with a message the agent can act on; the
 * loop hands a thrown tool error straight back to the model, so this reuses
 * the existing retry/feedback path. No-op for any tool that isn't a handoff.
 *
 * Mirrors commit-validation.ts's validateBeforeCommit.
 */
export function validateBeforeLaunchHandoff(
  toolName: string,
  payload: LaunchHandoffPayload,
  state: LaunchPropertyState,
  opts: { dryRun?: boolean; shadow?: boolean } = {}
): void {
  if (!isLaunchHandoffTool(toolName)) return;

  const { ok, errors } = validateLaunchHandoff(payload, state, opts);
  if (!ok) {
    throw new Error(
      `Launch validation gate blocked ${toolName} — the library was NOT populated. ` +
        `Fix these and call it again:\n${errors.map((e) => `- ${e}`).join('\n')}`
    );
  }
}

/**
 * Collect the rule components + data elements a handoff carries, from the
 * handoff tool's own arguments plus the components/data elements the run
 * created earlier (passed in by the caller). Shapes vary — the agent may pass
 * them inline on the library call, or create them first and only name them —
 * so this reads the common inline shapes defensively and unions in the
 * run-collected ones.
 */
export function collectHandoffPayload(args: unknown, collected: Partial<LaunchHandoffPayload> = {}): LaunchHandoffPayload {
  const ruleComponents: unknown[] = [...(collected.ruleComponents ?? [])];
  const dataElements: unknown[] = [...(collected.dataElements ?? [])];

  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const key of ['rule_components', 'ruleComponents', 'components']) {
      const v = a[key];
      if (Array.isArray(v)) ruleComponents.push(...v);
    }
    for (const key of ['data_elements', 'dataElements']) {
      const v = a[key];
      if (Array.isArray(v)) dataElements.push(...v);
    }
  }

  return { ruleComponents, dataElements };
}

// ── Run-scoped gate wiring ─────────────────────────────────────────────────────

/**
 * One per Launch-mode run (created in agent.ts and passed into buildAiTools,
 * alongside GroundingState / WriteDeduper). It:
 *
 *   - watches every tool call: observing read/create results to build the
 *     property state (installed extensions, known data elements) and
 *     collecting the rule components + data elements the run creates, so the
 *     handoff can be validated against what the run actually did; and
 *   - gates the library handoff: before a reactor_create_library /
 *     reactor_update_library call reaches the MCP server, runs the three
 *     checks and throws (blocking the write) on any failure.
 *
 * Non-Launch runs get no gate (undefined), so the wrapper is a no-op there and
 * nothing changes for them.
 */
export class LaunchValidationGate {
  readonly state = new LaunchPropertyState();
  private readonly createdRuleComponents: unknown[] = [];
  private readonly createdDataElements: unknown[] = [];

  constructor(private readonly opts: { dryRun?: boolean; shadow?: boolean } = {}) {}

  /**
   * Observe a successful tool call (name + args + result): absorb property
   * state and remember any rule component / data element the run created, so
   * the handoff is validated against the resources actually built this run.
   */
  observe(toolName: string, args: unknown, result: unknown): void {
    this.state.observe(toolName, args, result);
    if (RULE_COMPONENT_WRITE_TOOLS.has(toolName) && args && typeof args === 'object') {
      this.createdRuleComponents.push(args);
    }
    if (
      (toolName === 'reactor_create_data_element' || toolName === 'reactor_update_data_element') &&
      args &&
      typeof args === 'object'
    ) {
      this.createdDataElements.push(args);
    }
  }

  /**
   * Gate a tool call BEFORE it executes. Throws (no MCP write sent) when the
   * tool is a library handoff and validation fails; no-op otherwise. The
   * thrown error flows back to the model through the loop's existing
   * tool-error feedback path.
   */
  gate(toolName: string, args: unknown): void {
    if (!isLaunchHandoffTool(toolName)) return;
    const payload = collectHandoffPayload(args, {
      ruleComponents: this.createdRuleComponents,
      dataElements: this.createdDataElements,
    });
    validateBeforeLaunchHandoff(toolName, payload, this.state, this.opts);
  }
}

// Re-export for the wiring layer so it can tell a write from a read without
// re-deriving the rule (keeps the classification in one place).
export { classifyTool };
export { RULE_COMPONENT_WRITE_TOOLS };
