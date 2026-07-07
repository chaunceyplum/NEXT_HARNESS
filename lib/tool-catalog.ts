/**
 * Tool Catalog
 *
 * The allowlist of real, working MCP tools the dynamic planner
 * (lib/llm-planner.ts) is permitted to synthesize calls to. This is the
 * safety boundary that lets planning be genuinely non-deterministic without
 * ever inventing calls to tools that don't exist or can't be invoked:
 *
 *   - An LLM synthesizes an arbitrary, ask-specific plan (which tools, with
 *     what arguments, chained how) — see synthesizePlan() in llm-planner.ts.
 *   - Every step it proposes is validated against THIS catalog before the
 *     plan is accepted: the tool must be listed here, every required
 *     parameter must be supplied (directly or via a ref), refs must be
 *     well-formed and point at earlier steps, and the plan size is capped.
 *   - Anything that fails validation rejects the whole synthesized plan and
 *     falls back to the deterministic heuristic.
 *
 * Only tools that are known to work over the MCP JSON-RPC bridge are listed.
 * Deliberately excluded: msb_execute_solution (dispatcher/json.loads
 * collision + 30s Lambda timeout) and msb_generate_launch_config (its
 * registered wrapper's positional args don't match the underlying
 * function). See earlier PR history for details.
 *
 * `refOutputs` documents which fields a tool's result exposes for chaining,
 * so the LLM prompt can tell the model how to wire step outputs into later
 * step inputs (e.g. adobe_create_schema -> "$id" -> adobe_create_dataset's
 * schema_ref_id).
 */

export type ToolCategory = 'rag' | 'aep' | 'launch' | 'cja' | 'ajo';

export interface CatalogParam {
  name: string;
  required: boolean;
  /** Loose type hint for the prompt; not strictly enforced at validation. */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
}

export interface CatalogTool {
  name: string;
  category: ToolCategory;
  description: string;
  params: CatalogParam[];
  /** Result field paths usable in a downstream step's `refs` (e.g. "$id", "data_views.0.id"). */
  refOutputs: string[];
  /** Whether this tool should default to critical (aborts the run on failure). */
  defaultCritical: boolean;
}

export const TOOL_CATALOG: CatalogTool[] = [
  // ── RAG ──────────────────────────────────────────────────────────────────
  {
    name: 'search_adobe_knowledge',
    category: 'rag',
    description: 'Semantic search over the Adobe Experience Cloud knowledge base (AEP, CJA, AJO, Launch, Web SDK). Use for grounding/context.',
    params: [
      { name: 'query', required: true, type: 'string', description: 'Natural language search query.' },
      { name: 'topic', required: false, type: 'string', description: "Optional topic filter, e.g. 'aep', 'analytics', 'launch'." },
    ],
    refOutputs: [],
    defaultCritical: false,
  },

  // ── AEP ──────────────────────────────────────────────────────────────────
  {
    name: 'adobe_create_schema',
    category: 'aep',
    description: 'Create an XDM schema (typically a profile schema) that data lands into.',
    params: [
      { name: 'title', required: true, type: 'string', description: 'Schema title.' },
      { name: 'base_class', required: true, type: 'string', description: "XDM base class $id, e.g. 'https://ns.adobe.com/xdm/context/profile' or '.../experienceevent'." },
      { name: 'description', required: false, type: 'string', description: 'Schema description.' },
      { name: 'mixin_ids', required: false, type: 'array', description: 'Optional field group / mixin $ids to compose in.' },
    ],
    refOutputs: ['$id'],
    defaultCritical: true,
  },
  {
    name: 'adobe_create_dataset',
    category: 'aep',
    description: 'Create a dataset backed by an XDM schema. Requires the schema $id.',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Dataset name.' },
      { name: 'schema_ref_id', required: true, type: 'string', description: "The schema's $id (ref from adobe_create_schema.$id)." },
      { name: 'description', required: false, type: 'string', description: 'Dataset description.' },
    ],
    refOutputs: ['id'],
    defaultCritical: true,
  },
  {
    name: 'adobe_create_segment',
    category: 'aep',
    description: 'Create a Real-Time CDP audience segment from a PQL expression.',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Segment name.' },
      { name: 'pql_expression', required: true, type: 'string', description: 'Profile Query Language expression defining membership.' },
      { name: 'description', required: false, type: 'string', description: 'Segment description.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },

  // ── Adobe Launch (Reactor) — data collection ──────────────────────────────
  {
    name: 'reactor_create_property',
    category: 'launch',
    description: 'Create a Launch tag property for a website (the container for extensions, rules, data elements).',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Property name.' },
      { name: 'platform', required: true, type: 'string', description: "Platform, usually 'web'." },
      { name: 'domains', required: false, type: 'array', description: 'Array of domains for the property.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_list_extension_packages',
    category: 'launch',
    description: 'Search the public Launch extension catalog (e.g. to find the Web SDK package id to install).',
    params: [
      { name: 'search', required: false, type: 'string', description: 'Name/keyword filter, e.g. "Adobe Experience Platform Web SDK".' },
      { name: 'platform', required: false, type: 'string', description: "Platform filter, usually 'web'." },
      { name: 'limit', required: false, type: 'number', description: 'Max results.' },
    ],
    refOutputs: ['packages.0.id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_install_extension',
    category: 'launch',
    description: 'Install an extension package onto a property.',
    params: [
      { name: 'property_id', required: true, type: 'string', description: 'Property id (ref from reactor_create_property.id).' },
      { name: 'extension_package_id', required: true, type: 'string', description: 'Extension package id (ref from reactor_list_extension_packages.packages.0.id).' },
      { name: 'settings', required: false, type: 'object', description: 'Optional extension settings.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_create_data_element',
    category: 'launch',
    description: 'Create a data element on a property (a reusable reference to a piece of page data).',
    params: [
      { name: 'property_id', required: true, type: 'string', description: 'Property id (ref from reactor_create_property.id).' },
      { name: 'name', required: true, type: 'string', description: 'Data element name.' },
      { name: 'delegate_descriptor_id', required: true, type: 'string', description: "Delegate id, e.g. 'core::dataElements::javascript-variable'." },
      { name: 'settings', required: false, type: 'string', description: 'JSON string of type-specific settings.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_create_rule',
    category: 'launch',
    description: 'Create an empty rule on a property (add triggers/actions via reactor_create_rule_component).',
    params: [
      { name: 'property_id', required: true, type: 'string', description: 'Property id (ref from reactor_create_property.id).' },
      { name: 'name', required: true, type: 'string', description: 'Rule name.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_create_rule_component',
    category: 'launch',
    description: 'Add a component (event/trigger, condition, or action) to a rule.',
    params: [
      { name: 'rule_id', required: true, type: 'string', description: 'Rule id (ref from reactor_create_rule.id).' },
      { name: 'name', required: true, type: 'string', description: 'Component name.' },
      { name: 'delegate_descriptor_id', required: true, type: 'string', description: "Delegate id, e.g. 'core::events::dom-ready' or 'core::actions::custom-code'." },
      { name: 'settings', required: false, type: 'string', description: 'JSON string of component settings.' },
      { name: 'order', required: false, type: 'number', description: 'Execution order within the rule.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_create_environment',
    category: 'launch',
    description: 'Create a publish environment (development/staging/production) on a property.',
    params: [
      { name: 'property_id', required: true, type: 'string', description: 'Property id (ref from reactor_create_property.id).' },
      { name: 'name', required: true, type: 'string', description: 'Environment name.' },
      { name: 'stage', required: false, type: 'string', description: "One of 'development', 'staging', 'production'." },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_create_library',
    category: 'launch',
    description: 'Create a build library on a property (the unit that bundles rules/data elements for a build).',
    params: [
      { name: 'property_id', required: true, type: 'string', description: 'Property id (ref from reactor_create_property.id).' },
      { name: 'name', required: true, type: 'string', description: 'Library name.' },
      { name: 'environment_id', required: false, type: 'string', description: 'Environment id (ref from reactor_create_environment.id).' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'reactor_add_resources_to_library',
    category: 'launch',
    description: 'Add rules / data elements / extensions to a library. Supports list-refs to bundle many at once.',
    params: [
      { name: 'library_id', required: true, type: 'string', description: 'Library id (ref from reactor_create_library.id).' },
      { name: 'rule_ids', required: false, type: 'array', description: 'Array of rule ids (list-ref from reactor_create_rule.id).' },
      { name: 'data_element_ids', required: false, type: 'array', description: 'Array of data element ids (list-ref from reactor_create_data_element.id).' },
      { name: 'extension_ids', required: false, type: 'array', description: 'Array of extension ids.' },
    ],
    refOutputs: [],
    defaultCritical: false,
  },
  {
    name: 'reactor_build_library',
    category: 'launch',
    description: 'Trigger a build for a library. Call after adding resources. (Stops short of publish — a human reviews.)',
    params: [
      { name: 'library_id', required: true, type: 'string', description: 'Library id (ref from reactor_create_library.id).' },
    ],
    refOutputs: [],
    defaultCritical: false,
  },

  // ── CJA — analytics ────────────────────────────────────────────────────────
  {
    name: 'cja_list_data_views',
    category: 'cja',
    description: 'List CJA data views (report suites) — resolve one before creating CJA segments/metrics/projects.',
    params: [
      { name: 'limit', required: false, type: 'number', description: 'Max data views to return.' },
    ],
    refOutputs: ['data_views.0.id'],
    defaultCritical: false,
  },
  {
    name: 'cja_create_segment',
    category: 'cja',
    description: 'Create a CJA segment for reporting, scoped to a data view.',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Segment name.' },
      { name: 'data_view_id', required: true, type: 'string', description: 'Data view id (ref from cja_list_data_views.data_views.0.id).' },
      { name: 'definition', required: true, type: 'object', description: 'CJA segment definition object.' },
      { name: 'description', required: false, type: 'string', description: 'Segment description.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'cja_create_calculated_metric',
    category: 'cja',
    description: 'Create a CJA calculated metric, scoped to a data view.',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Metric name.' },
      { name: 'data_view_id', required: true, type: 'string', description: 'Data view id (ref from cja_list_data_views.data_views.0.id).' },
      { name: 'definition', required: true, type: 'object', description: 'CJA calculated metric definition object.' },
      { name: 'description', required: false, type: 'string', description: 'Metric description.' },
      { name: 'metric_type', required: false, type: 'string', description: "e.g. 'DECIMAL'." },
      { name: 'polarity', required: false, type: 'string', description: "'positive' or 'negative'." },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },
  {
    name: 'cja_create_project',
    category: 'cja',
    description: 'Create a CJA Workspace project (dashboard). Optionally scoped to a data view.',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Project name.' },
      { name: 'data_view_id', required: false, type: 'string', description: 'Data view id to scope to (ref from cja_list_data_views.data_views.0.id).' },
      { name: 'description', required: false, type: 'string', description: 'Project description.' },
      { name: 'definition', required: false, type: 'object', description: 'Optional Workspace definition object.' },
    ],
    refOutputs: ['id'],
    defaultCritical: false,
  },

  // ── AJO — activation / personalization ─────────────────────────────────────
  {
    name: 'msb_create_ajo_journey',
    category: 'ajo',
    description: 'Create an Adobe Journey Optimizer journey with audience entry criteria (outbound activation).',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Journey name.' },
      { name: 'entry_criteria', required: true, type: 'object', description: "Entry criteria object, e.g. { type: 'segment', segment_name: '...' }." },
    ],
    refOutputs: ['journey_id'],
    defaultCritical: false,
  },
  {
    name: 'msb_create_ajo_offer',
    category: 'ajo',
    description: 'Create an AJO personalization offer for a placement (on-site/email content).',
    params: [
      { name: 'name', required: true, type: 'string', description: 'Offer name.' },
      { name: 'placement_type', required: true, type: 'string', description: 'Placement identifier, e.g. "hero_banner".' },
      { name: 'content', required: true, type: 'object', description: 'Offer content object (e.g. { html, fallback_text }).' },
      { name: 'eligibility_rules', required: false, type: 'object', description: 'Optional eligibility rules (e.g. { segments: [...] }).' },
    ],
    refOutputs: ['offer_id'],
    defaultCritical: false,
  },
  {
    name: 'msb_activate_ajo_campaign',
    category: 'ajo',
    description: 'Activate an AJO journey for live decisioning. Requires the journey id.',
    params: [
      { name: 'journey_id', required: true, type: 'string', description: 'Journey id (ref from msb_create_ajo_journey.journey_id).' },
    ],
    refOutputs: [],
    defaultCritical: false,
  },
];

const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

export function getCatalogTool(name: string): CatalogTool | undefined {
  return CATALOG_BY_NAME.get(name);
}

// ── Synthesized step validation ──────────────────────────────────────────────

/** The raw shape an LLM is asked to emit per step (before we trust it). */
export interface SynthesizedStepInput {
  id?: unknown;
  label?: unknown;
  tool?: unknown;
  critical?: unknown;
  args?: unknown;
  refs?: unknown;
  listRefs?: unknown;
}

/** A validated, trusted step ready to become a PlannedStep. */
export interface ValidatedStep {
  id: string;
  label: string;
  tool: string;
  category: ToolCategory;
  critical: boolean;
  args: Record<string, unknown>;
  refs?: Record<string, string>;
  listRefs?: Record<string, string[]>;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  steps?: ValidatedStep[];
}

const MAX_SYNTHESIZED_STEPS = 40;
const REF_PATTERN = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_$.]+$/;

/**
 * Validate an LLM-synthesized step list against the catalog. Strict and
 * all-or-nothing: any problem rejects the entire plan (the caller then
 * falls back to the deterministic heuristic), so a partially-hallucinated
 * plan can never reach the runner.
 */
export function validateSynthesizedSteps(rawSteps: unknown): ValidationResult {
  if (!Array.isArray(rawSteps)) {
    return { ok: false, error: 'Synthesized plan "steps" is not an array.' };
  }
  if (rawSteps.length === 0) {
    return { ok: false, error: 'Synthesized plan has no steps.' };
  }
  if (rawSteps.length > MAX_SYNTHESIZED_STEPS) {
    return { ok: false, error: `Synthesized plan has too many steps (${rawSteps.length} > ${MAX_SYNTHESIZED_STEPS}).` };
  }

  const validated: ValidatedStep[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i] as SynthesizedStepInput;
    const where = `step ${i}`;

    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `${where} is not an object.` };
    }

    // id
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `step_${i}`;
    if (seenIds.has(id)) {
      return { ok: false, error: `${where} has duplicate id "${id}".` };
    }

    // tool must be in the catalog
    if (typeof raw.tool !== 'string') {
      return { ok: false, error: `${where} is missing a string "tool".` };
    }
    const catalogTool = getCatalogTool(raw.tool);
    if (!catalogTool) {
      return { ok: false, error: `${where} references unknown/disallowed tool "${raw.tool}".` };
    }

    // args
    const args: Record<string, unknown> =
      raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)
        ? { ...(raw.args as Record<string, unknown>) }
        : {};

    // refs
    let refs: Record<string, string> | undefined;
    if (raw.refs !== undefined) {
      if (typeof raw.refs !== 'object' || raw.refs === null || Array.isArray(raw.refs)) {
        return { ok: false, error: `${where} has a non-object "refs".` };
      }
      refs = {};
      for (const [k, v] of Object.entries(raw.refs as Record<string, unknown>)) {
        if (typeof v !== 'string' || !REF_PATTERN.test(v)) {
          return { ok: false, error: `${where} ref "${k}" is not a valid "stepId.path" string.` };
        }
        const srcId = v.split('.')[0];
        if (!seenIds.has(srcId)) {
          return { ok: false, error: `${where} ref "${k}" points at "${srcId}" which is not an earlier step.` };
        }
        refs[k] = v;
      }
    }

    // listRefs
    let listRefs: Record<string, string[]> | undefined;
    if (raw.listRefs !== undefined) {
      if (typeof raw.listRefs !== 'object' || raw.listRefs === null || Array.isArray(raw.listRefs)) {
        return { ok: false, error: `${where} has a non-object "listRefs".` };
      }
      listRefs = {};
      for (const [k, v] of Object.entries(raw.listRefs as Record<string, unknown>)) {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && REF_PATTERN.test(x))) {
          return { ok: false, error: `${where} listRef "${k}" is not an array of valid "stepId.path" strings.` };
        }
        for (const ref of v as string[]) {
          const srcId = ref.split('.')[0];
          if (!seenIds.has(srcId)) {
            return { ok: false, error: `${where} listRef "${k}" points at "${srcId}" which is not an earlier step.` };
          }
        }
        listRefs[k] = v as string[];
      }
    }

    // required params must be satisfied by args, refs, or listRefs
    const suppliedKeys = new Set<string>([
      ...Object.keys(args),
      ...Object.keys(refs ?? {}),
      ...Object.keys(listRefs ?? {}),
    ]);
    const missing = catalogTool.params
      .filter((p) => p.required && !suppliedKeys.has(p.name))
      .map((p) => p.name);
    if (missing.length > 0) {
      return { ok: false, error: `${where} (${catalogTool.name}) is missing required param(s): ${missing.join(', ')}.` };
    }

    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `${catalogTool.name}`;
    // Criticality is taken from the catalog default (never trust the LLM to
    // decide what aborts a run), unless the LLM explicitly marked it true.
    const critical = raw.critical === true || catalogTool.defaultCritical;

    seenIds.add(id);
    validated.push({
      id,
      label,
      tool: catalogTool.name,
      category: catalogTool.category,
      critical,
      args,
      refs,
      listRefs,
    });
  }

  return { ok: true, steps: validated };
}

/** Compact catalog description for embedding in the synthesis prompt. */
export function catalogForPrompt(): string {
  return TOOL_CATALOG.map((t) => {
    const params = t.params
      .map((p) => `${p.name}${p.required ? '*' : ''}:${p.type}`)
      .join(', ');
    const refs = t.refOutputs.length ? ` | ref outputs: ${t.refOutputs.join(', ')}` : '';
    return `- ${t.name} [${t.category}]: ${t.description}\n    params: ${params}${refs}`;
  }).join('\n');
}
