/**
 * Plan Builder
 *
 * Converts a planner-produced SolutionConfig into an ordered list of
 * individual MCP tool calls against tools that actually exist and work
 * today: RAG (knowledge search), AEP (schema/dataset/segment), Adobe
 * Launch/Reactor (tag property, Web SDK, per-event data elements + rules,
 * library build), CJA (data view/segment/calculated metric), and AJO
 * (journey/offer/activation).
 *
 * This deliberately does NOT call msb_execute_solution / orchestrator_*.
 * Those require infra identifiers the planner cannot produce (client_name,
 * site_repo, netlify_site_id) and are bound by a 30s Lambda timeout that a
 * 9-phase build cannot complete within. See PR discussion for details.
 *
 * ── DYNAMIC PLANNING ─────────────────────────────────────────────────────
 * Earlier versions of this file concatenated one fixed sequence of modules
 * (RAG -> AEP -> Launch -> CJA -> AJO) for every request. That's wrong: a
 * "build me an analytics dashboard, no activation needed" use case doesn't
 * need AJO at all; a "just get purchase tracking live" use case doesn't
 * need CJA reporting; a personalization-heavy use case needs AJO *offers*
 * (which didn't exist before) more than journeys.
 *
 * Instead, capability is expressed as a set of independent MODULES (see
 * `MODULES` below). Each module declares:
 *   - isApplicable(config): whether this use case needs it at all
 *   - reason(config): a one-line explanation, surfaced to the user
 *   - priority(config): a use-case-dependent sort key — the same module
 *     can run earlier or later depending on the config (e.g. CJA runs
 *     before AJO for an "analytics-first" use case, after it for an
 *     "activation-first" one)
 *   - build(config, ctx): produces this module's PlannedStep[]
 *
 * `planUseCase()` filters to applicable modules, orders them by priority
 * (a heuristic that reads the config — see `classifyUseCase`), and
 * concatenates their steps. `buildStepPlan()` remains as a thin sync
 * wrapper around the heuristic path for callers/tests that don't need LLM
 * refinement.
 *
 * Optionally, `lib/llm-planner.ts` can refine the module selection/order
 * by asking an LLM (only if ANTHROPIC_API_KEY is configured) — see
 * `planUseCaseAsync()` in that file, which is what the build API route
 * actually calls. The heuristic here is always the fallback: if there's no
 * API key, the LLM call fails, times out, or returns something invalid,
 * planning silently degrades to this deterministic logic. There is no
 * "LLM required" path.
 *
 * Each step declares the MCP tool name + a template for its arguments.
 * Arguments may reference outputs of earlier steps via the `refs` field —
 * the runner resolves these at execution time once dependent steps finish.
 */

import { SolutionConfig } from './types';

export interface PlannedStep {
  id: string;
  label: string;
  tool: string;
  category: 'rag' | 'aep' | 'launch' | 'cja' | 'ajo';
  critical: boolean;
  /** Static arguments known ahead of time. */
  args: Record<string, any>;
  /**
   * Dynamic argument refs: maps an arg name to `${stepId}.${resultPath}`.
   * Resolved once the referenced step has completed successfully.
   */
  refs?: Record<string, string>;
  /**
   * Dynamic *array* argument refs: maps an arg name to a list of
   * `${stepId}.${resultPath}` refs. Each is resolved independently and any
   * that fail to resolve (e.g. an optional upstream step failed/skipped)
   * are silently dropped from the array rather than failing the step —
   * used for "bundle whatever succeeded" calls like adding resources to a
   * Launch library.
   */
  listRefs?: Record<string, string[]>;
}

export type ModuleId = 'rag' | 'aep' | 'launch' | 'cja' | 'ajo_activation' | 'ajo_offers';

/**
 * A self-contained capability. Modules never assume they run at a fixed
 * position — `build()` receives a `ModuleContext` with whatever earlier
 * modules produced (e.g. AEP segment step ids), and degrades gracefully
 * (falls back to its own defaults) if a dependency it would have preferred
 * didn't run.
 */
export interface CapabilityModule {
  id: ModuleId;
  /** Human-readable label for planning-transparency output. */
  label: string;
  /** Whether this use case needs this module at all. */
  isApplicable: (config: SolutionConfig) => boolean;
  /** One-line explanation of the isApplicable decision, for transparency. */
  reason: (config: SolutionConfig) => string;
  /**
   * Use-case-dependent sort key. Lower runs earlier. The *same* module can
   * return a different priority for different configs — this is what
   * makes ordering dynamic rather than a fixed sequence.
   */
  priority: (config: SolutionConfig, useCase: UseCaseProfile) => number;
  /** Produce this module's steps, given whatever context earlier modules left behind. */
  build: (config: SolutionConfig, ctx: ModuleContext) => PlannedStep[];
}

export interface ModuleContext {
  /** Step ids of AEP segments created by the 'aep' module, if it ran. */
  aepSegmentStepIds: string[];
  /** Step id of the AEP schema, if the 'aep' module ran (for refs). */
  aepSchemaStepId?: string;
  /**
   * Short unique token for THIS build run, appended to created-resource
   * names so re-running the same request doesn't collide with resources
   * created by a previous run. Adobe rejects a duplicate schema title with
   * a 400, which is exactly what a re-run with a static name produces —
   * this is what prevents that.
   */
  runToken: string;
}

/** Generate a short, URL/name-safe token unique to a build run. */
export function makeRunToken(): string {
  // Timestamp (disambiguates across runs) + 6 random base36 chars (~2.1B
  // space, so even rapid successive calls within the same millisecond don't
  // collide). Kept short enough to read in a resource name.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * A coarse read on *why* this build looks the way it does, used to pick
 * per-module priorities. Not exhaustive classification — just enough
 * signal to reorder modules meaningfully. Exposed in planning-transparency
 * output so it's clear why the order came out the way it did.
 */
export interface UseCaseProfile {
  /** True if the config leans toward outbound activation (email/push/sms/web + segments). */
  activationFocused: boolean;
  /** True if the config leans toward reporting/analytics over activation. */
  analyticsFocused: boolean;
  /** True if the config has on-site personalization placements to fill. */
  personalizationFocused: boolean;
  /** True if there's any real data-collection need (events beyond a bare default). */
  needsDataCollection: boolean;
  /** Human-readable summary, surfaced to the user. */
  summary: string;
}

export function classifyUseCase(config: SolutionConfig): UseCaseProfile {
  const destinations = (Array.isArray(config.destinations) ? config.destinations : []).map((d) =>
    String(d).toLowerCase()
  );
  const goals = (Array.isArray(config.goals) ? config.goals : []).map((g) => String(g).toLowerCase());
  const placements = Array.isArray(config.personalization_placements) ? config.personalization_placements : [];
  const hasRealEvents = Array.isArray(config.events) && config.events.length > 0;
  const hasRealSegments = Array.isArray(config.segments) && config.segments.length > 0;

  const activationDestinations = destinations.filter((d) => ['email', 'web', 'push', 'sms'].includes(d));
  // NOTE: this used to also fire on `destinations.length === 0`, i.e. "no
  // destinations means the use case must be about analytics" — that's
  // backwards. An empty destinations array on a narrow ask (e.g. "build me
  // a schema in AEP") isn't an analytics signal at all; it's the absence
  // of ANY signal. Only an explicit reporting/engagement goal or a CRM
  // destination should mark a use case as analytics-focused.
  const analyticsSignals = goals.some((g) => g.includes('engagement') || g.includes('conversion_rate') || g.includes('report'));

  const activationFocused = activationDestinations.length > 0 && hasRealSegments;
  const personalizationFocused = placements.length > 0 || destinations.includes('web');
  const analyticsFocused = !activationFocused && (analyticsSignals || destinations.includes('crm'));

  const parts: string[] = [];
  if (activationFocused) parts.push('activation-focused (has segments + an outbound destination)');
  if (personalizationFocused) parts.push('personalization-focused (on-site placements or "web" destination)');
  if (analyticsFocused) parts.push('analytics-focused (no outbound destination, or CRM/reporting goals)');
  if (parts.length === 0) parts.push('general-purpose (no strong signal toward activation, personalization, or analytics)');

  return {
    activationFocused,
    analyticsFocused,
    personalizationFocused,
    needsDataCollection: hasRealEvents || destinations.length > 0,
    summary: parts.join('; '),
  };
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'item';
}

// ──────────────────────────────────────────────────────────────────────────
// MODULE: RAG grounding
// ──────────────────────────────────────────────────────────────────────────
const ragModule: CapabilityModule = {
  id: 'rag',
  label: 'RAG knowledge grounding',
  isApplicable: () => true, // always cheap, always useful context; never blocks anything
  reason: () => 'Always run for context — non-critical and informs later steps\' defaults.',
  priority: () => 0, // always first: every other module's steps benefit from being informed, and it's non-critical/instant
  build: (config) => {
    const vertical = config.business_vertical || 'general';
    return [
      {
        id: 'rag_adobe',
        label: `Search Adobe knowledge base for "${vertical}" patterns`,
        tool: 'search_adobe_knowledge',
        category: 'rag',
        critical: false,
        args: { query: `${vertical} segmentation and personalization best practices` },
      },
    ];
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MODULE: AEP foundation (schema, dataset, segments)
// ──────────────────────────────────────────────────────────────────────────
const aepModule: CapabilityModule = {
  id: 'aep',
  label: 'AEP foundation (schema, dataset, segments)',
  // Foundational for nearly every use case — the one exception is a config
  // that is pure knowledge-base lookup with zero events/segments/domain
  // signal, which isApplicable filters out rather than forcing empty
  // schema/dataset calls with placeholder names.
  isApplicable: (config) => {
    const hasDomain = !!config.website_domain && config.website_domain !== 'example.com';
    const hasEvents = Array.isArray(config.events) && config.events.length > 0;
    const hasSegments = Array.isArray(config.segments) && config.segments.length > 0;
    return hasDomain || hasEvents || hasSegments;
  },
  reason: (config) => {
    const hasDomain = !!config.website_domain && config.website_domain !== 'example.com';
    return hasDomain
      ? `A concrete website domain (${config.website_domain}) needs a profile schema + dataset to land data into.`
      : 'Events or segments were specified, which need a schema/dataset foundation to attach to.';
  },
  // Foundational work runs early regardless of use case shape — activation,
  // analytics, and personalization all need the same schema/dataset/segment
  // primitives to exist first.
  priority: () => 10,
  build: (config, ctx) => {
    const vertical = config.business_vertical || 'general';
    const domain = config.website_domain || 'example.com';
    const segments = Array.isArray(config.segments) ? config.segments : [];
    const steps: PlannedStep[] = [];

    const schemaStepId = 'aep_schema';
    steps.push({
      id: schemaStepId,
      label: `Create XDM profile schema for ${domain}`,
      tool: 'adobe_create_schema',
      category: 'aep',
      critical: true,
      args: {
        title: `${slug(domain)}_${vertical}_profile_${ctx.runToken}`,
        base_class: 'https://ns.adobe.com/xdm/context/profile',
        description: `Profile schema for ${domain} (${vertical}) generated by harness build`,
      },
    });
    ctx.aepSchemaStepId = schemaStepId;

    const datasetStepId = 'aep_dataset';
    steps.push({
      id: datasetStepId,
      label: 'Create dataset backed by the new schema',
      tool: 'adobe_create_dataset',
      category: 'aep',
      critical: true,
      args: {
        name: `${slug(domain)}_${vertical}_dataset_${ctx.runToken}`,
        description: `Dataset for ${domain} profile data`,
      },
      refs: { schema_ref_id: `${schemaStepId}.$id` },
    });

    // NOTE: this used to fall back to a synthetic 'engaged_visitors'
    // segment whenever config.segments was empty. That's the root cause of
    // downstream modules (cja/ajo_activation) seeing "a segment exists"
    // for use cases that never asked for one at all (e.g. "build me a
    // schema in AEP"). Only create segment steps for segments the
    // user/enrichment actually supplied — if there are none, create none.
    segments.forEach((seg: any, idx: number) => {
      const stepId = `aep_segment_${idx}`;
      ctx.aepSegmentStepIds.push(stepId);
      steps.push({
        id: stepId,
        label: `Create AEP segment: ${seg.name || `segment_${idx}`}`,
        tool: 'adobe_create_segment',
        category: 'aep',
        critical: false,
        args: {
          name: seg.name || `segment_${idx}`,
          pql_expression: seg.pql_expression || 'profile.visits > 1',
          description: seg.description || '',
        },
      });
    });

    return steps;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MODULE: Adobe Launch (Reactor) — data collection instrumentation
// ──────────────────────────────────────────────────────────────────────────
const launchModule: CapabilityModule = {
  id: 'launch',
  label: 'Adobe Launch (Reactor) data collection',
  // Only needed if there's something to collect. A pure reporting-on-
  // existing-data or activation-only-on-existing-segments use case (no
  // events at all) has nothing for Launch to instrument.
  isApplicable: (config) => Array.isArray(config.events) && config.events.length > 0,
  reason: (config) => {
    const n = Array.isArray(config.events) ? config.events.length : 0;
    return n > 0
      ? `${n} event(s) identified that need client-side instrumentation to collect.`
      : 'No events identified — nothing for Launch to instrument.';
  },
  // Data collection has to exist before there's anything meaningful to
  // report on or activate against, so it runs right after the AEP
  // foundation regardless of use-case shape.
  priority: () => 20,
  build: (config, ctx) => {
    const vertical = config.business_vertical || 'general';
    const domain = config.website_domain || 'example.com';
    const steps: PlannedStep[] = [];

    const propertyStepId = 'launch_property';
    steps.push({
      id: propertyStepId,
      label: `Create Adobe Launch property for ${domain}`,
      tool: 'reactor_create_property',
      category: 'launch',
      critical: false,
      args: { name: `${slug(domain)}_${vertical}_${ctx.runToken}`, platform: 'web', domains: [domain] },
    });

    const extensionSearchStepId = 'launch_search_websdk';
    steps.push({
      id: extensionSearchStepId,
      label: 'Look up the Web SDK extension package in the catalog',
      tool: 'reactor_list_extension_packages',
      category: 'launch',
      critical: false,
      args: { search: 'Adobe Experience Platform Web SDK', platform: 'web', limit: 5 },
    });

    steps.push({
      id: 'launch_install_websdk',
      label: 'Install Web SDK extension on the property',
      tool: 'reactor_install_extension',
      category: 'launch',
      critical: false,
      args: {},
      refs: {
        property_id: `${propertyStepId}.id`,
        extension_package_id: `${extensionSearchStepId}.packages.0.id`,
      },
    });

    // Events drive what gets instrumented — a finance signup flow gets a
    // form_fill rule, an ecommerce site gets a purchase rule, etc., instead
    // of one generic template regardless of input.
    //
    // NOTE: build() is only ever called when isApplicable() returned true,
    // which requires config.events.length > 0 (see above) — so the
    // `eventList` here should always be non-empty. There is deliberately
    // NO synthetic 'page_view' fallback anymore: it used to exist "just in
    // case", but a defensive default here would silently mask a bug in
    // isApplicable() rather than surface it, and it was part of the same
    // "empty means yes" pattern that caused Launch to be built for use
    // cases (like a schema-only AEP ask) that never asked for it.
    const eventList: any[] = config.events;

    const launchRuleStepIds: string[] = [];
    const launchDataElementStepIds: string[] = [];

    eventList.forEach((evt: any, idx: number) => {
      const eventName: string = (typeof evt === 'string' ? evt : evt?.name) || `event_${idx}`;

      const dataElementStepId = `launch_data_element_${idx}`;
      launchDataElementStepIds.push(dataElementStepId);
      steps.push({
        id: dataElementStepId,
        label: `Create data element for "${eventName}"`,
        tool: 'reactor_create_data_element',
        category: 'launch',
        critical: false,
        args: {
          name: `${eventName} - event flag`,
          delegate_descriptor_id: 'core::dataElements::javascript-variable',
          settings: JSON.stringify({ path: `window.adobeDataLayer[0].event === '${eventName}'` }),
        },
        refs: { property_id: `${propertyStepId}.id` },
      });

      const ruleStepId = `launch_rule_${idx}`;
      launchRuleStepIds.push(ruleStepId);
      steps.push({
        id: ruleStepId,
        label: `Create rule: ${vertical} - ${eventName}`,
        tool: 'reactor_create_rule',
        category: 'launch',
        critical: false,
        args: { name: `${vertical} - ${eventName} tracking` },
        refs: { property_id: `${propertyStepId}.id` },
      });

      steps.push({
        id: `launch_rule_trigger_${idx}`,
        label: `Add page-load trigger to "${eventName}" rule`,
        tool: 'reactor_create_rule_component',
        category: 'launch',
        critical: false,
        args: { name: 'Page Load Trigger', delegate_descriptor_id: 'core::events::dom-ready', order: 0 },
        refs: { rule_id: `${ruleStepId}.id` },
      });

      steps.push({
        id: `launch_rule_action_${idx}`,
        label: `Add tracking action to "${eventName}" rule`,
        tool: 'reactor_create_rule_component',
        category: 'launch',
        critical: false,
        args: {
          name: `Track ${eventName}`,
          delegate_descriptor_id: 'core::actions::custom-code',
          order: 1,
          settings: JSON.stringify({
            source: `// Starter action for "${eventName}" (${vertical}) — customize with your analytics/Web SDK call.\nif (window.adobeDataLayer && window.adobeDataLayer[0] && window.adobeDataLayer[0].event === '${eventName}') {\n  console.log('[${vertical}] tracked event: ${eventName}');\n}`,
          }),
        },
        refs: { rule_id: `${ruleStepId}.id` },
      });
    });

    const environmentStepId = 'launch_environment';
    steps.push({
      id: environmentStepId,
      label: 'Create development publish environment',
      tool: 'reactor_create_environment',
      category: 'launch',
      critical: false,
      args: { name: 'Development', stage: 'development' },
      refs: { property_id: `${propertyStepId}.id` },
    });

    const libraryStepId = 'launch_library';
    steps.push({
      id: libraryStepId,
      label: `Create build library for ${domain}`,
      tool: 'reactor_create_library',
      category: 'launch',
      critical: false,
      args: { name: `${slug(domain)}_${vertical}_library_${ctx.runToken}` },
      refs: { property_id: `${propertyStepId}.id`, environment_id: `${environmentStepId}.id` },
    });

    steps.push({
      id: 'launch_add_resources',
      label: 'Add rules and data elements to the library',
      tool: 'reactor_add_resources_to_library',
      category: 'launch',
      critical: false,
      args: {},
      refs: { library_id: `${libraryStepId}.id` },
      listRefs: {
        rule_ids: launchRuleStepIds.map((id) => `${id}.id`),
        data_element_ids: launchDataElementStepIds.map((id) => `${id}.id`),
      },
    });

    // NOTE: deliberately stops at "build" — the library remains in
    // 'development' state. Submitting/approving/publishing
    // (reactor_transition_library) would push real config toward a live
    // production property, which this harness does not do automatically;
    // a human should review the build in the Reactor UI first.
    steps.push({
      id: 'launch_build',
      label: 'Trigger a build for the library',
      tool: 'reactor_build_library',
      category: 'launch',
      critical: false,
      args: {},
      refs: { library_id: `${libraryStepId}.id` },
    });

    return steps;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MODULE: CJA analytics
// ──────────────────────────────────────────────────────────────────────────
const cjaModule: CapabilityModule = {
  id: 'cja',
  label: 'CJA analytics (data view, segment, calculated metric)',
  // Needed whenever there's any reporting intent — which is effectively
  // whenever there are REAL segments to measure, OR the use case is
  // explicitly analytics-focused (reporting/engagement goals or a CRM
  // destination). "hasSegments" alone used to be too permissive because
  // aepModule.build() injected a synthetic default segment whenever
  // config.segments was empty, so ANY request (even a bare schema ask)
  // ended up looking like it "had a segment worth reporting on". Now that
  // aepModule no longer synthesizes a default segment (see aepModule.build
  // above), config.segments.length > 0 genuinely means the user/enrichment
  // asked for a segment — which IS worth mirroring in CJA for reporting,
  // so mere real-segment presence remains a valid signal on its own.
  isApplicable: (config) => {
    const hasSegments = Array.isArray(config.segments) && config.segments.length > 0;
    const profile = classifyUseCase(config);
    return hasSegments || profile.analyticsFocused;
  },
  reason: (config) => {
    const profile = classifyUseCase(config);
    if (profile.analyticsFocused) return 'Use case is analytics-focused (reporting/engagement goals, or a CRM destination) — CJA is the primary deliverable.';
    const hasSegments = Array.isArray(config.segments) && config.segments.length > 0;
    return hasSegments
      ? 'Segments exist that are worth reporting on in CJA alongside AEP.'
      : 'No segments and no explicit analytics/reporting signal — CJA is not included.';
  },
  priority: (config, useCase) => {
    // Analytics-first use cases want CJA reporting stood up before (or in
    // place of) activation; activation-first use cases want CJA as a
    // secondary reporting layer *after* the audience is already live in
    // AJO. This is the concrete "same module, different position
    // depending on the use case" behavior.
    return useCase.analyticsFocused ? 25 : 40;
  },
  build: (config, ctx) => {
    const vertical = config.business_vertical || 'general';
    const domain = config.website_domain || 'example.com';
    const segments = Array.isArray(config.segments) ? config.segments : [];
    const primarySegmentName = segments[0]?.name || 'engaged_visitors';
    const steps: PlannedStep[] = [];

    const dataViewStepId = 'cja_data_views';
    steps.push({
      id: dataViewStepId,
      label: 'Resolve an available CJA data view',
      tool: 'cja_list_data_views',
      category: 'cja',
      critical: false,
      args: { limit: 5 },
    });

    steps.push({
      id: 'cja_segment',
      label: 'Mirror primary segment in CJA for reporting',
      tool: 'cja_create_segment',
      category: 'cja',
      critical: false,
      args: {
        name: `${primarySegmentName}_cja_${ctx.runToken}`,
        description: `CJA reporting segment mirroring AEP segment for ${vertical}`,
        definition: {
          func: 'segment',
          version: [1, 0, 0],
          container: {
            func: 'container',
            context: 'sessions',
            pred: { func: 'event', evt: { func: 'metric', name: 'metrics/pageviews' }, op: 'gt', val: 1 },
          },
        },
      },
      refs: { data_view_id: `${dataViewStepId}.data_views.0.id` },
    });

    steps.push({
      id: 'cja_metric',
      label: `Create calculated metric for ${vertical} engagement`,
      tool: 'cja_create_calculated_metric',
      category: 'cja',
      critical: false,
      args: {
        name: `${vertical}_engagement_rate_${ctx.runToken}`,
        description: `Engagement rate metric for ${domain}`,
        metric_type: 'DECIMAL',
        polarity: 'positive',
        definition: { func: 'calc-metric', version: [1, 0, 0], formula: { func: 'metric', name: 'metrics/pageviews' } },
      },
      refs: { data_view_id: `${dataViewStepId}.data_views.0.id` },
    });

    return steps;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MODULE: AJO activation (journeys per segment)
// ──────────────────────────────────────────────────────────────────────────
const ajoActivationModule: CapabilityModule = {
  id: 'ajo_activation',
  label: 'AJO activation (journeys per segment)',
  isApplicable: (config) => {
    const hasSegments = Array.isArray(config.segments) && config.segments.length > 0;
    const destinations = (Array.isArray(config.destinations) ? config.destinations : []).map((d) => String(d).toLowerCase());
    // An empty destinations array must NOT imply activation is wanted —
    // that "assume yes by default" branch used to fire AJO activation for
    // any request with segments, even a narrow schema-only ask. Only fire
    // when the user explicitly specified an activation-channel
    // destination (email/web/push/sms).
    const wantsActivation = destinations.some((d) => ['email', 'web', 'push', 'sms'].includes(d));
    return hasSegments && wantsActivation;
  },
  reason: (config) => {
    const destinations = Array.isArray(config.destinations) ? config.destinations : [];
    const activationDestinations = destinations.filter((d) => ['email', 'web', 'push', 'sms'].includes(String(d).toLowerCase()));
    return activationDestinations.length > 0
      ? `Destinations (${destinations.join(', ')}) include an activation channel (email/web/push/sms).`
      : 'No explicit activation-channel destination (email/web/push/sms) — AJO activation is not included.';
  },
  priority: (config, useCase) => (useCase.activationFocused ? 25 : 45),
  build: (config, ctx) => {
    const vertical = config.business_vertical || 'general';
    // isApplicable() above requires hasSegments to be true, so config.segments
    // is guaranteed non-empty here — no synthetic default segment needed.
    const segments = Array.isArray(config.segments) ? config.segments : [];
    const steps: PlannedStep[] = [];

    segments.forEach((seg: any, idx: number) => {
      const journeyStepId = `ajo_journey_${idx}`;
      steps.push({
        id: journeyStepId,
        label: `Create AJO journey for ${seg.name || `segment_${idx}`}`,
        tool: 'msb_create_ajo_journey',
        category: 'ajo',
        critical: false,
        args: {
          name: `${vertical}_${seg.name || `segment_${idx}`}_journey_${ctx.runToken}`,
          entry_criteria: { type: 'segment', segment_name: seg.name || `segment_${idx}` },
        },
      });

      steps.push({
        id: `ajo_activate_${idx}`,
        label: `Activate journey for ${seg.name || `segment_${idx}`}`,
        tool: 'msb_activate_ajo_campaign',
        category: 'ajo',
        critical: false,
        args: {},
        refs: { journey_id: `${journeyStepId}.journey_id` },
      });
    });

    // If the AEP module ran and produced segment step ids, note the
    // pairing in the label for transparency — no technical ref is needed
    // since journeys key off segment *name* (a plain string), not the
    // AEP segment's created id.
    void ctx.aepSegmentStepIds;

    return steps;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MODULE: AJO offers (on-site/email personalization content)
// ──────────────────────────────────────────────────────────────────────────
// New — previously there was no module for this at all, so every use case
// got journeys/activation regardless of whether the actual ask was
// on-site personalization content rather than outbound messaging.
const ajoOffersModule: CapabilityModule = {
  id: 'ajo_offers',
  label: 'AJO offers (personalization content)',
  isApplicable: (config) => {
    const placements = Array.isArray(config.personalization_placements) ? config.personalization_placements : [];
    const destinations = (Array.isArray(config.destinations) ? config.destinations : []).map((d) => String(d).toLowerCase());
    return placements.length > 0 || destinations.includes('web');
  },
  reason: (config) => {
    const placements = Array.isArray(config.personalization_placements) ? config.personalization_placements : [];
    return placements.length > 0
      ? `Personalization placements identified (${placements.join(', ')}) — need offer content for each.`
      : '"web" destination implies on-site personalization content.';
  },
  // Personalization-focused use cases want offers front-and-center, close
  // to activation; otherwise it's a lower-priority addition after the
  // primary activation/analytics work.
  priority: (config, useCase) => (useCase.personalizationFocused ? 30 : 50),
  build: (config, ctx) => {
    const vertical = config.business_vertical || 'general';
    const domain = config.website_domain || 'example.com';
    const placements: string[] = Array.isArray(config.personalization_placements) && config.personalization_placements.length > 0
      ? config.personalization_placements
      : ['hero_banner'];
    const primarySegmentName = (Array.isArray(config.segments) && config.segments[0]?.name) || 'engaged_visitors';

    return placements.map((placement, idx) => ({
      id: `ajo_offer_${idx}`,
      label: `Create AJO offer for "${placement}" placement`,
      tool: 'msb_create_ajo_offer',
      category: 'ajo' as const,
      critical: false,
      args: {
        name: `${vertical}_${slug(placement)}_offer_${ctx.runToken}`,
        placement_type: placement,
        content: {
          html: `<div>Personalized ${vertical} content for ${domain} — ${placement}</div>`,
          fallback_text: `Welcome to ${domain}`,
        },
        eligibility_rules: { segments: [primarySegmentName] },
      },
    }));
  },
};

export const MODULES: CapabilityModule[] = [
  ragModule,
  aepModule,
  launchModule,
  cjaModule,
  ajoActivationModule,
  ajoOffersModule,
];

export interface ModulePlanSummary {
  id: ModuleId;
  label: string;
  included: boolean;
  reason: string;
  stepCount: number;
}

export interface UseCasePlan {
  steps: PlannedStep[];
  useCase: UseCaseProfile;
  modules: ModulePlanSummary[];
}

/**
 * Deterministic, heuristic planning: filter modules to the ones this
 * config actually needs, order them by their use-case-dependent priority,
 * and concatenate their steps. This is the fallback path used whenever LLM
 * refinement (lib/llm-planner.ts) is unavailable, disabled, or fails — and
 * is also what runs when called directly (e.g. from tests).
 */
export function planUseCase(config: SolutionConfig, runToken: string = makeRunToken()): UseCasePlan {
  const useCase = classifyUseCase(config);
  const ctx: ModuleContext = { aepSegmentStepIds: [], runToken };

  const applicability = MODULES.map((mod) => ({
    mod,
    included: mod.isApplicable(config),
    reason: mod.reason(config),
  }));

  const ordered = applicability
    .filter((a) => a.included)
    .map((a) => ({ ...a, priority: a.mod.priority(config, useCase) }))
    .sort((a, b) => a.priority - b.priority);

  // Build steps AND the transparency summary in the same pass, in actual
  // execution order — this is what module_order in API responses and the
  // UI's step-order badges reflect. (Modules not included are appended
  // after, in declaration order, purely for the "skipped modules" list —
  // order doesn't matter for those since they never ran.)
  const steps: PlannedStep[] = [];
  const summaries: ModulePlanSummary[] = [];

  for (const { mod, reason } of ordered) {
    const modSteps = mod.build(config, ctx);
    steps.push(...modSteps);
    summaries.push({ id: mod.id, label: mod.label, included: true, reason, stepCount: modSteps.length });
  }

  for (const { mod, included, reason } of applicability) {
    if (!included) {
      summaries.push({ id: mod.id, label: mod.label, included: false, reason, stepCount: 0 });
    }
  }

  return { steps, useCase, modules: summaries };
}

/**
 * Backwards-compatible sync entry point returning just the step list, for
 * callers/tests that don't need the planning-transparency metadata.
 */
export function buildStepPlan(config: SolutionConfig, runToken?: string): PlannedStep[] {
  return planUseCase(config, runToken).steps;
}

/**
 * Resolve a dotted path like "aep_schema.$id" or "cja_data_views.data_views.0.id"
 * against a map of stepId -> result payload.
 */
export function resolveRef(ref: string, results: Record<string, any>): any {
  const [stepId, ...pathParts] = ref.split('.');
  let value: any = results[stepId];
  for (const part of pathParts) {
    if (value === undefined || value === null) return undefined;
    const idx = Number(part);
    value = Number.isInteger(idx) && !Number.isNaN(idx) && Array.isArray(value)
      ? value[idx]
      : value[part];
  }
  return value;
}
