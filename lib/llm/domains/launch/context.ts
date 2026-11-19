/**
 * The Launch/Reactor blocks of the cached system prompt. Moved verbatim from
 * lib/llm/runtime/agent-core.ts: the text must stay byte-identical, since it is
 * part of the prompt cache prefix and the promptVersion fingerprint.
 */

/**
 * Canonical Adobe Launch (Reactor) object-model contract, injected into the
 * cached system-prompt prefix the SAME way getEnvironmentContext() injects
 * HARNESS_CONTEXT (lib/llm/runtime/agent-core.ts) — but GATED to Launch-mode
 * runs (see launchPack) so non-Launch runs keep their lean prefix and prompt cache.
 *
 * Kept deliberately tight: it rides the cached prompt prefix on every step of
 * a Launch run, so it grounds the object model and the hard output boundary
 * without reproducing documentation the knowledge base already covers.
 */
export function launchDomainContext(publishEnabled: boolean): string {
  // The handoff/output line is the ONLY difference between the publish and
  // non-publish variants. When publishEnabled is false this array is
  // byte-identical to the historical LAUNCH_DOMAIN_CONTEXT, so a non-publish
  // Launch run's prompt (and its promptVersion fingerprint) is unchanged.
  const handoffLine = publishEnabled
    ? 'Output / handoff contract: you are producing code to be committed to the repo and loaded into a Launch library for devs to test, and this run MAY publish that library to the named dev/staging environment. Publishing is permitted ONLY to a development or staging environment — a production environment is refused in code. End by reporting the library id and, if you published, the environment and published build.'
    : 'Output / handoff contract: you are producing code to be committed to the repo and loaded into a Launch library for devs to test; do NOT publish to an environment. End by creating/populating the library and reporting its id.';
  return [
    'Adobe Launch (Reactor) object model — ground every tag change in this hierarchy:',
    '- A property holds libraries, rules, data elements, and extensions. A library is the unit devs load to test; it bundles the rule/data-element/extension revisions under test.',
    '- A rule = events + conditions + actions. Each of those is a rule component with a delegate_descriptor_id (e.g. "core::events::click") naming the extension delegate it runs, plus a settings object holding that delegate\'s configuration.',
    '- A data element has a name, a delegate_descriptor_id (its type, e.g. "core::dataElements::variable"), a settings object, and a storage_duration ("pageview" | "session" | "visitor", or none for no persistence).',
    '- An extension is an installed package (extension_package) a property configures; rule components and data elements reference its delegates by delegate_descriptor_id.',
    handoffLine,
    'Validation rules the generated code must satisfy:',
    '- Every rule component\'s delegate_descriptor_id must come from an extension present in the property (install the extension first if it is missing).',
    '- Every data element referenced from custom code must already exist in the property or be created in the same library.',
  ].join('\n');
}

/**
 * Operational guidance for calling the reactor_* tools (Adobe Launch API,
 * reactor.adobe.io, JSON:API). Companion to LAUNCH_DOMAIN_CONTEXT: that block
 * grounds WHAT the Launch objects are; this block grounds the ORDER to touch
 * them in and the state-machine / error traps the model keeps hitting — most
 * reactor_* "errors" come from ignoring the resource dependency order or a
 * resource's state machine, not from a broken tool.
 *
 * Injected into the cached prefix under the same `launchMode` gate as
 * LAUNCH_DOMAIN_CONTEXT. Kept to the high-value dependency chain + the common
 * traps; the full reference (search fields, callback/secret/audit specifics,
 * the which-tool map) lives in docs/reactor-tools-context.md.
 */
export function launchToolsContext(publishEnabled: boolean): string {
  // Only the libraries/builds/publishing line differs between variants; every
  // other line is identical. When publishEnabled is false this array is
  // byte-identical to the historical LAUNCH_TOOLS_CONTEXT.
  const libraryLine = publishEnabled
    ? 'Libraries / builds / publishing is a state machine — order matters: reactor_create_library bound to a DEVELOPMENT environment_id → reactor_add_resources_to_library (re-revises automatically) → reactor_build_library (returns build_id, status pending; a development library builds to its development environment) → poll reactor_get_build until status succeeded → reactor_transition_library with action "submit" (moves it to submitted, which builds to the property\'s staging environment). Submitting before a successful build returns 409 "Last build was not successful." A library can only be deleted while in development state. This run MAY publish to development/staging only: populate the library, build it, poll reactor_get_build until status "succeeded", and, if the target is staging, transition it with action "submit" and build again. NEVER use action "approve" or "publish" and never build an approved library — those are the production path and are refused in code. If a build\'s status comes back "failed", fix the components and rebuild — do not transition a failed build.'
    : 'Libraries / builds / publishing is a state machine — order matters: reactor_create_library bound to an environment_id → reactor_add_resources_to_library (re-revises automatically) → reactor_build_library (returns build_id, status pending) → poll reactor_get_build until status succeeded → reactor_transition_library submit → approve → publish. Submitting before a successful build returns 409 "Last build was not successful." A library can only be deleted while in development state. (Per the handoff contract above, stop at a populated library for devs to test — do not publish.)';
  return [
    'Adobe Reactor (reactor_*) tool usage — most failures come from ignoring resource order or a resource state machine, not from a broken tool:',
    'Resource dependency chain (create top-down, delete bottom-up): company → property → { extensions, hosts → environment, data_elements, rules → rule_components, callbacks, libraries → builds }. Resolve a property_id FIRST (reactor_list_properties, or reactor_create_property) — almost every other tool needs it. There is no root /properties list; it is company-scoped.',
    'Extensions: a new property ALREADY has Core installed — do NOT reactor_install_extension for Core (409 "can only add each extension_package once"); reactor_list_extensions and reuse it. reactor_install_extension is for additional packages (Web SDK, Analytics, …). Install the extension that provides a delegate BEFORE creating a data element or rule component that uses it — the prefix before "::" in delegate_descriptor_id is the extension name.',
    'Data elements & rule components: delegate_descriptor_id is extensionName::type::delegateName (e.g. core::events::click, core::dataElements::javascript-variable, core::actions::custom-code). settings is type-specific JSON; for core::actions::custom-code include a source (language defaults to javascript). Do not pass extension_id — it is auto-resolved from the delegate prefix unless disambiguation is needed.',
    libraryLine,
    'Secrets (reactor_create_secret / list_secrets / …) work ONLY on event-forwarding (Edge) properties; on a normal web/mobile tag property they 405/409 — do not call them unless the property is event-forwarding.',
    'reactor_search matches a field against a term, not free text — it defaults to attributes.name; pass field (e.g. attributes.settings, attributes.delegate_descriptor_id) to match others, scope with property_id, and narrow with resource_types. Audit events are company-level only (property_id is accepted but ignored — filter with type_filter).',
    'Deleting a property cascades its rules, data elements, environments, hosts, libraries, and callbacks, and is irreversible on the live account — confirm property_id before reactor_delete_property.',
  ].join('\n');
}
