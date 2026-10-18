# Adobe Reactor (Launch) tools — usage context

Guidance for calling the `reactor_*` tools. These wrap the Adobe Launch API
(reactor.adobe.io, JSON:API). Most "errors" come not from broken tools but from
ignoring the resource dependency order or a resource's state machine.

A compact version of this guidance is injected into the agent's system prompt
in Launch mode (`LAUNCH_TOOLS_CONTEXT` in `lib/llm/agent-core.ts`); this file is
the full reference.

## Resource dependency chain — create top-down, delete bottom-up

```
company (fixed, 1 per org)
└─ property                      ← reactor_create_property FIRST
   ├─ extensions                 ← Core is auto-installed; add others before using their delegates
   ├─ hosts                      ← needed before an environment
   │  └─ environment             ← needs a host; needed before a buildable library
   ├─ data_elements              ← need the providing extension installed
   ├─ rules
   │  └─ rule_components         ← need the rule AND the providing extension
   ├─ callbacks
   └─ libraries                  ← bind to an environment to be buildable
      └─ builds
```

Always resolve a `property_id` first (`reactor_list_properties` → pick one, or
`reactor_create_property`). Almost every other tool needs it directly or via a
parent resource. There is no root `/properties` list; it's company-scoped and
handled for you.

## Per-area rules the model keeps getting wrong

### Extensions
- A new property already has the Core extension installed. Do NOT
  `reactor_install_extension` for Core — it returns 409 "can only add each
  extension_package once." To use it, `reactor_list_extensions` and reuse the
  existing one.
- `reactor_install_extension` is for additional packages (Web SDK, Analytics,
  etc.). Configurable extensions also need `delegate_descriptor_id` + `settings`;
  Core-style ones must NOT get a `delegate_descriptor_id`.
- Before creating a data element or rule component, make sure the extension that
  provides its delegate is installed. The delegate prefix before `::` is the
  extension name (`core::dataElements::javascript-variable` → `core`).

### Data elements & rule components
- `delegate_descriptor_id` format: `extensionName::type::delegateName`
  (e.g. `core::events::click`, `core::dataElements::javascript-variable`,
  `core::actions::custom-code`).
- `settings` is type-specific JSON. For `core::actions::custom-code` include a
  `source`; `language` defaults to `javascript` automatically.
- You usually don't pass `extension_id` — it's auto-resolved from the delegate
  prefix. Only pass it to disambiguate.

### Libraries, builds, publishing (a state machine — order matters)
- `reactor_create_library` with an `environment_id` (bind to an environment, or
  the build has nowhere to go).
- `reactor_add_resources_to_library` (rules / data_elements / extensions). After
  any edit a resource must be re-revised; the tool does this (`revise=True`).
- `reactor_build_library` → returns a `build_id` with status `pending`.
- Poll `reactor_get_build` until status is `succeeded` before transitioning.
- `reactor_transition_library` submit → approve → publish. Submitting before a
  successful build returns 409 "Last build was not successful."
- A library can only be deleted while in `development` state.
- Read current members with `reactor_list_library_resources` (reads the
  per-type relationship endpoints).

### Callbacks (webhooks)
- `reactor_update_callback` always sends `url`; if you only want to change
  subscriptions, the tool fetches and reuses the current url. You can still pass
  `url` explicitly to change it.
- `subscriptions` is a list like `['rule.created','library.published']`; omit to
  subscribe to all.

### Secrets — EDGE / event-forwarding properties ONLY
- `reactor_create_secret` / `list_secrets` / etc. work only on event-forwarding
  (Edge) properties. On a normal web/mobile tag property they 405/409 with
  "Property … is not …". Don't call them unless the property is event-forwarding.

### Search — structured, not free text
- `reactor_search` matches a field against a term, not a bare full-text string.
  Defaults to matching `attributes.name`.
- To search other fields pass `field`, e.g. `attributes.*` (any attribute),
  `attributes.delegate_descriptor_id`, `attributes.settings`.
- Scope with `property_id` and narrow with `resource_types`
  (`['rules','data_elements','rule_components']`).
- Example: find rule components referencing a data element →
  `field='attributes.settings'`, `query='<dataElementName>'`,
  `resource_types=['rule_components']`.

### Audit events
- Company-level only. `property_id` is accepted but ignored — don't expect
  per-property filtering. Use `type_filter` (e.g. `rule.created`) instead.

### Cleanup / safety
- Deleting a property cascades its rules, data elements, environments, hosts,
  libraries, callbacks — use it to tear down a whole scratch property in one call.
- Deletes are irreversible on the live account. Confirm `property_id` before
  `reactor_delete_property`.

## Quick "which tool" map

| Goal | Call |
| --- | --- |
| Find/choose a property | `reactor_list_properties` |
| Stand up a testable property | `create_property` → (Core already there) → `create_host` → `create_environment` |
| Add a tag rule that fires on click | `create_rule` → `create_rule_component` (`core::events::click`) |
| Reusable value | `create_data_element` |
| Ship it | add to library → `build_library` → poll `get_build` → `transition_library` |
| Find something by name | `reactor_search` (defaults to `attributes.name`) |
