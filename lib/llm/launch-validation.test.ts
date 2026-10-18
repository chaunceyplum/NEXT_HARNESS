import { describe, expect, it } from 'vitest';
import {
  collectHandoffPayload,
  dataElementReferencesIn,
  extensionOfDelegate,
  isLaunchHandoffTool,
  isPublishTransitionTool,
  LaunchPropertyState,
  LaunchValidationGate,
  resolveEnvironmentStage,
  validateBeforeLaunchHandoff,
  validateBeforeTransition,
  validateDataElementShape,
  validateLaunchHandoff,
  validateReferences,
  validateRuleComponentShape,
} from './launch-validation';

// A well-formed rule component / data element as the reactor create tools receive them.
const goodComponent = {
  delegate_descriptor_id: 'core::events::click',
  settings: { elementSelector: '.add-to-cart' },
};
const goodDataElement = {
  name: 'Cart Item SKU',
  delegate_descriptor_id: 'core::dataElements::variable',
  settings: { path: 'digitalData.cart.items' },
  storage_duration: 'session' as const,
};

/** A property state with the core extension installed and one known data element. */
function groundedState(): LaunchPropertyState {
  const state = new LaunchPropertyState();
  state.addExtension('core');
  state.addDataElement('Cart Item SKU');
  return state;
}

describe('extensionOfDelegate', () => {
  it('takes the extension name from the delegate id prefix', () => {
    expect(extensionOfDelegate('core::events::click')).toBe('core');
    expect(extensionOfDelegate('adobe-analytics::actions::set-variables')).toBe('adobe-analytics');
  });
});

// ── (1) STRUCTURAL ──────────────────────────────────────────────────────────────

describe('validateRuleComponentShape', () => {
  it('accepts a well-formed rule component', () => {
    expect(validateRuleComponentShape(goodComponent)).toEqual([]);
  });

  it('rejects a delegate id that is not extension::type::delegate', () => {
    const errors = validateRuleComponentShape({ delegate_descriptor_id: 'click', settings: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/delegate_descriptor_id/);
    expect(errors[0]).toMatch(/extension::type::delegate/);
  });

  it('rejects a missing settings object', () => {
    const errors = validateRuleComponentShape({ delegate_descriptor_id: 'core::events::click' });
    expect(errors.some((e) => e.startsWith('settings:'))).toBe(true);
  });

  it('reports a readable path for a nested problem', () => {
    const errors = validateRuleComponentShape({ delegate_descriptor_id: 123, settings: {} });
    expect(errors[0]).toMatch(/^delegate_descriptor_id:/);
  });
});

describe('validateDataElementShape', () => {
  it('accepts a well-formed data element', () => {
    expect(validateDataElementShape(goodDataElement)).toEqual([]);
  });

  it('allows an omitted storage_duration (no persistence)', () => {
    const { storage_duration: _omit, ...rest } = goodDataElement;
    void _omit;
    expect(validateDataElementShape(rest)).toEqual([]);
  });

  it('rejects an unknown storage_duration', () => {
    const errors = validateDataElementShape({ ...goodDataElement, storage_duration: 'forever' });
    expect(errors.some((e) => e.startsWith('storage_duration:'))).toBe(true);
  });

  it('rejects a missing name', () => {
    const { name: _omit, ...rest } = goodDataElement;
    void _omit;
    expect(validateDataElementShape(rest).some((e) => e.startsWith('name:'))).toBe(true);
  });
});

// ── (2) REFERENCE ─────────────────────────────────────────────────────────────

describe('dataElementReferencesIn', () => {
  it('pulls percent-wrapped data element names out of settings', () => {
    expect(dataElementReferencesIn({ source: 'var sku = %Cart Item SKU%;' })).toEqual(['Cart Item SKU']);
  });

  it('dedupes and reads nested/stringified settings', () => {
    const refs = dataElementReferencesIn({ a: '%One%', b: { c: '%Two% and %One%' } });
    expect(refs.sort()).toEqual(['One', 'Two']);
  });

  it('returns nothing when there are no references', () => {
    expect(dataElementReferencesIn({ elementSelector: '.btn' })).toEqual([]);
  });
});

describe('validateReferences', () => {
  it('passes when the delegate extension is installed and refs resolve', () => {
    const components = [{ delegate_descriptor_id: 'core::actions::custom-code', settings: { source: '%Cart Item SKU%' } }];
    expect(validateReferences(components, groundedState())).toEqual([]);
  });

  it('flags a delegate whose extension is not installed', () => {
    const components = [{ delegate_descriptor_id: 'adobe-analytics::actions::send-beacon', settings: {} }];
    const errors = validateReferences(components, groundedState());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/adobe-analytics/);
    expect(errors[0]).toMatch(/not installed/);
  });

  it('flags a data element reference that is not known', () => {
    const components = [{ delegate_descriptor_id: 'core::actions::custom-code', settings: { source: '%Unknown DE%' } }];
    const errors = validateReferences(components, groundedState());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unknown DE/);
    expect(errors[0]).toMatch(/does not exist/);
  });
});

// ── LaunchPropertyState ingestion ───────────────────────────────────────────────

describe('LaunchPropertyState.observe', () => {
  it('records installed extensions from a reactor_list_extensions result', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_list_extensions', {}, { data: [{ attributes: { name: 'adobe-analytics' } }, { attributes: { name: 'core' } }] });
    expect(state.installedExtensions.has('core')).toBe(true);
    expect(state.installedExtensions.has('adobe-analytics')).toBe(true);
  });

  it('derives an extension name from a delegate id in the result', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_list_extensions', {}, { data: [{ attributes: { delegate_descriptor_id: 'core::events::click' } }] });
    expect(state.installedExtensions.has('core')).toBe(true);
  });

  it('records data elements from a list result and from a create call argument', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_list_data_elements', {}, { data: [{ attributes: { name: 'Existing DE' } }] });
    state.observe('reactor_create_data_element', { name: 'Fresh DE' }, { data: { attributes: { name: 'Fresh DE' } } });
    expect(state.knownDataElements.has('Existing DE')).toBe(true);
    expect(state.knownDataElements.has('Fresh DE')).toBe(true);
  });

  it('never throws on an unexpected result shape', () => {
    const state = new LaunchPropertyState();
    expect(() => state.observe('reactor_list_extensions', null, 'not an object')).not.toThrow();
    expect(state.installedExtensions.size).toBe(0);
  });
});

// ── validateLaunchHandoff (all three checks together) ───────────────────────────

describe('validateLaunchHandoff', () => {
  it('passes a structurally valid, fully-resolved handoff', () => {
    const result = validateLaunchHandoff(
      { ruleComponents: [{ delegate_descriptor_id: 'core::actions::custom-code', settings: { source: '%Cart Item SKU%' } }], dataElements: [goodDataElement] },
      groundedState()
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('collects structural, reference, and resolution problems together', () => {
    const result = validateLaunchHandoff(
      {
        ruleComponents: [
          { delegate_descriptor_id: 'bad id', settings: {} }, // structural
          { delegate_descriptor_id: 'web-sdk::events::send', settings: { source: '%Nope%' } }, // extension + DE refs
        ],
        dataElements: [{ name: 'x', delegate_descriptor_id: 'core::dataElements::variable', settings: {}, storage_duration: 'eternal' }], // structural
      },
      groundedState()
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('rule component [0]'))).toBe(true);
    expect(result.errors.some((e) => e.includes('web-sdk') && e.includes('not installed'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Nope'))).toBe(true);
    expect(result.errors.some((e) => e.includes('data element [0]') && e.includes('storage_duration'))).toBe(true);
  });

  it('does not reference-check a structurally invalid component', () => {
    // A malformed delegate id can't be split into an extension, so it only
    // produces the structural error, not a spurious "extension not installed".
    const result = validateLaunchHandoff(
      { ruleComponents: [{ delegate_descriptor_id: 'oops', settings: {} }], dataElements: [] },
      new LaunchPropertyState()
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/rule component \[0\]/);
  });

  it('result is the same union of checks in dry-run / shadow mode', () => {
    const payload = { ruleComponents: [{ delegate_descriptor_id: 'web-sdk::events::send', settings: {} }], dataElements: [] };
    const live = validateLaunchHandoff(payload, groundedState());
    const shadow = validateLaunchHandoff(payload, groundedState(), { shadow: true });
    const dry = validateLaunchHandoff(payload, groundedState(), { dryRun: true });
    expect(shadow).toEqual(live);
    expect(dry).toEqual(live);
    expect(live.ok).toBe(false);
  });
});

// ── isLaunchHandoffTool / validateBeforeLaunchHandoff (the gate) ─────────────────

describe('isLaunchHandoffTool', () => {
  it('is true for the library create/update handoff and false otherwise', () => {
    expect(isLaunchHandoffTool('reactor_create_library')).toBe(true);
    expect(isLaunchHandoffTool('reactor_update_library')).toBe(true);
    expect(isLaunchHandoffTool('reactor_create_rule')).toBe(false);
    expect(isLaunchHandoffTool('reactor_build_library')).toBe(false); // publishing is out of scope
  });
});

describe('validateBeforeLaunchHandoff', () => {
  it('is a no-op for a non-handoff tool', () => {
    expect(() => validateBeforeLaunchHandoff('reactor_create_rule', { ruleComponents: [{}], dataElements: [] }, new LaunchPropertyState())).not.toThrow();
  });

  it('does not throw when all three checks pass', () => {
    expect(() =>
      validateBeforeLaunchHandoff(
        'reactor_create_library',
        { ruleComponents: [goodComponent], dataElements: [goodDataElement] },
        groundedState()
      )
    ).not.toThrow();
  });

  it('throws a BLOCKED error listing the findings when a check fails', () => {
    expect(() =>
      validateBeforeLaunchHandoff(
        'reactor_create_library',
        { ruleComponents: [{ delegate_descriptor_id: 'web-sdk::events::send', settings: {} }], dataElements: [] },
        groundedState()
      )
    ).toThrow(/blocked reactor_create_library[\s\S]*web-sdk[\s\S]*not installed/i);
  });
});

// ── collectHandoffPayload ───────────────────────────────────────────────────────

describe('collectHandoffPayload', () => {
  it('reads inline components/data elements off the handoff arguments', () => {
    const payload = collectHandoffPayload({ rule_components: [goodComponent], data_elements: [goodDataElement] });
    expect(payload.ruleComponents).toEqual([goodComponent]);
    expect(payload.dataElements).toEqual([goodDataElement]);
  });

  it('unions run-collected resources with inline ones', () => {
    const payload = collectHandoffPayload(
      { components: [goodComponent] },
      { ruleComponents: [{ delegate_descriptor_id: 'core::conditions::value-comparison', settings: {} }], dataElements: [goodDataElement] }
    );
    expect(payload.ruleComponents).toHaveLength(2);
    expect(payload.dataElements).toEqual([goodDataElement]);
  });

  it('tolerates arguments with no resource arrays', () => {
    expect(collectHandoffPayload({ name: 'cart-tracking' })).toEqual({ ruleComponents: [], dataElements: [] });
  });
});

// ── LaunchValidationGate (run-scoped wiring) ────────────────────────────────────

describe('LaunchValidationGate', () => {
  it('builds property state from observed reads and validates a later handoff', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_list_extensions', {}, { data: [{ attributes: { name: 'core' } }] });
    gate.observe('reactor_create_data_element', goodDataElement, { data: { attributes: { name: 'Cart Item SKU' } } });
    gate.observe('reactor_create_rule_component', { delegate_descriptor_id: 'core::actions::custom-code', settings: { source: '%Cart Item SKU%' } }, {});

    expect(() => gate.gate('reactor_create_library', {})).not.toThrow();
  });

  it('blocks a handoff when a created component references an uninstalled extension', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_list_extensions', {}, { data: [{ attributes: { name: 'core' } }] });
    gate.observe('reactor_create_rule_component', { delegate_descriptor_id: 'web-sdk::events::send', settings: {} }, {});

    expect(() => gate.gate('reactor_create_library', {})).toThrow(/web-sdk[\s\S]*not installed/i);
  });

  it('ignores a non-handoff tool in gate()', () => {
    const gate = new LaunchValidationGate();
    expect(() => gate.gate('reactor_create_rule', { anything: true })).not.toThrow();
  });
});

// ── Publish: environment-stage ingestion + resolution ───────────────────────────

describe('isPublishTransitionTool', () => {
  it('is true only for reactor_transition_library', () => {
    expect(isPublishTransitionTool('reactor_transition_library')).toBe(true);
    expect(isPublishTransitionTool('reactor_build_library')).toBe(false);
    expect(isPublishTransitionTool('reactor_create_library')).toBe(false);
  });
});

describe('LaunchPropertyState — environment stages', () => {
  it('records a stage from a reactor_get_environment result, keyed by id and name', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_get_environment', {}, { data: { id: 'EN123', type: 'environments', attributes: { name: 'Staging', stage: 'staging' } } });
    expect(state.stageOf('EN123')).toBe('staging');
    expect(state.stageOf('Staging')).toBe('staging');
    expect(state.stageOf('staging')).toBe('staging'); // case-insensitive name match
  });

  it('records multiple stages from a reactor_list_environments result', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_list_environments', {}, {
      data: [
        { id: 'EN1', attributes: { name: 'Dev', stage: 'development' } },
        { id: 'EN2', attributes: { name: 'Prod', stage: 'production' } },
      ],
    });
    expect(state.stageOf('EN1')).toBe('development');
    expect(state.stageOf('EN2')).toBe('production');
  });

  it('ignores an unknown stage value and never infers a stage from the name', () => {
    const state = new LaunchPropertyState();
    // "production" only appears in the NAME, not the stage field — must not resolve to production.
    state.observe('reactor_get_environment', {}, { data: { id: 'EN9', attributes: { name: 'production-mirror', stage: 'qa' } } });
    expect(state.stageOf('EN9')).toBeUndefined();
    expect(state.stageOf('production-mirror')).toBeUndefined();
  });

  it('never throws on an unexpected environment payload', () => {
    const state = new LaunchPropertyState();
    expect(() => state.observe('reactor_list_environments', null, 'nope')).not.toThrow();
    expect(state.environmentStages.size).toBe(0);
  });
});

describe('resolveEnvironmentStage', () => {
  function stagedState(): LaunchPropertyState {
    const state = new LaunchPropertyState();
    state.addEnvironmentStage('EN-DEV', 'development');
    state.addEnvironmentStage('EN-STAGE', 'staging');
    state.addEnvironmentStage('EN-PROD', 'production');
    return state;
  }

  it('resolves from the transition args (several key shapes)', () => {
    const state = stagedState();
    expect(resolveEnvironmentStage({ environment_id: 'EN-DEV' }, state)).toBe('development');
    expect(resolveEnvironmentStage({ environmentId: 'EN-STAGE' }, state)).toBe('staging');
    expect(resolveEnvironmentStage({ environment: { data: { id: 'EN-PROD' } } }, state)).toBe('production');
  });

  it('falls back to the run publishTarget when the args do not name an environment', () => {
    const state = stagedState();
    expect(resolveEnvironmentStage({}, state, { environmentId: 'EN-DEV' })).toBe('development');
  });

  it('is unknown when no candidate resolves to an observed stage', () => {
    const state = stagedState();
    expect(resolveEnvironmentStage({ environment_id: 'EN-MYSTERY' }, state)).toBe('unknown');
    expect(resolveEnvironmentStage({}, state)).toBe('unknown');
  });
});

describe('LaunchPropertyState — build status', () => {
  it('records the latest build status and surfaces a failed build error', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_get_build', {}, { data: { id: 'B1', attributes: { status: 'failed', error: 'component X invalid' } } });
    expect(state.latestBuildStatus).toBe('failed');
    expect(state.latestBuildError).toContain('component X invalid');
  });

  it('records a succeeded build with no error', () => {
    const state = new LaunchPropertyState();
    state.observe('reactor_get_build', {}, { data: { attributes: { status: 'succeeded' } } });
    expect(state.latestBuildStatus).toBe('succeeded');
    expect(state.latestBuildError).toBeUndefined();
  });
});

// ── Publish: the hard production block + build-failure refusal ───────────────────

function publishReadyState(stage: 'development' | 'staging' | 'production'): LaunchPropertyState {
  const state = new LaunchPropertyState();
  state.addEnvironmentStage('EN-TARGET', stage);
  state.latestBuildStatus = 'succeeded';
  return state;
}

describe('validateBeforeTransition', () => {
  it('is a no-op for a non-transition tool', () => {
    expect(() => validateBeforeTransition('reactor_create_library', {}, publishReadyState('production'))).not.toThrow();
  });

  it('ALLOWS a transition to a verified development or staging environment', () => {
    expect(() =>
      validateBeforeTransition('reactor_transition_library', { environment_id: 'EN-TARGET' }, publishReadyState('development'))
    ).not.toThrow();
    expect(() =>
      validateBeforeTransition('reactor_transition_library', { environment_id: 'EN-TARGET' }, publishReadyState('staging'))
    ).not.toThrow();
  });

  it('REFUSES a transition to a production environment (hard block)', () => {
    expect(() =>
      validateBeforeTransition('reactor_transition_library', { environment_id: 'EN-TARGET' }, publishReadyState('production'))
    ).toThrow(/production is not permitted[\s\S]*stage=production[\s\S]*EN-TARGET/i);
  });

  it('REFUSES a transition when the target stage is unknown', () => {
    const state = publishReadyState('development');
    expect(() =>
      validateBeforeTransition('reactor_transition_library', { environment_id: 'EN-UNSEEN' }, state)
    ).toThrow(/stage is unknown[\s\S]*reactor_get_environment/i);
  });

  it('REFUSES a transition when the latest build FAILED, surfacing the build error', () => {
    const state = publishReadyState('development');
    state.latestBuildStatus = 'failed';
    state.latestBuildError = 'rule component RC2 references a missing data element';
    expect(() =>
      validateBeforeTransition('reactor_transition_library', { environment_id: 'EN-TARGET' }, state)
    ).toThrow(/build FAILED[\s\S]*RC2 references a missing data element/i);
  });

  it('resolves the target from the run publishTarget when the args omit it', () => {
    const state = publishReadyState('staging');
    expect(() =>
      validateBeforeTransition('reactor_transition_library', {}, state, { environmentId: 'EN-TARGET' })
    ).not.toThrow();
  });
});

describe('LaunchValidationGate — publish transition', () => {
  it('builds environment stages from observed reads and ALLOWS a staging transition', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_list_environments', {}, { data: [{ id: 'EN-S', attributes: { name: 'Staging', stage: 'staging' } }] });
    gate.observe('reactor_get_build', {}, { data: { attributes: { status: 'succeeded' } } });
    expect(gate.resolveStageFor({ environment_id: 'EN-S' })).toBe('staging');
    expect(() => gate.gate('reactor_transition_library', { environment_id: 'EN-S' })).not.toThrow();
  });

  it('REFUSES a transition to an observed production environment (injected/hallucinated prod)', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_get_environment', {}, { data: { id: 'EN-P', attributes: { name: 'Prod', stage: 'production' } } });
    gate.observe('reactor_get_build', {}, { data: { attributes: { status: 'succeeded' } } });
    expect(() => gate.gate('reactor_transition_library', { environment_id: 'EN-P' })).toThrow(/production is not permitted/i);
  });

  it('REFUSES a transition when the stage was never read (unknown is not exempt)', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_get_build', {}, { data: { attributes: { status: 'succeeded' } } });
    expect(() => gate.gate('reactor_transition_library', { environment_id: 'EN-UNKNOWN' })).toThrow(/stage is unknown/i);
  });

  it('REFUSES a transition on a failed build before any stage check', () => {
    const gate = new LaunchValidationGate();
    gate.observe('reactor_list_environments', {}, { data: [{ id: 'EN-S', attributes: { stage: 'staging' } }] });
    gate.observe('reactor_get_build', {}, { data: { attributes: { status: 'failed', detail: 'bad component' } } });
    expect(() => gate.gate('reactor_transition_library', { environment_id: 'EN-S' })).toThrow(/build FAILED[\s\S]*bad component/i);
  });

  it('uses the run publishTarget as the resolution fallback for a bare transition', () => {
    const gate = new LaunchValidationGate({ publishTarget: { environmentId: 'EN-DEV' } });
    gate.observe('reactor_get_environment', {}, { data: { id: 'EN-DEV', attributes: { stage: 'development' } } });
    gate.observe('reactor_get_build', {}, { data: { attributes: { status: 'succeeded' } } });
    expect(gate.resolveStageFor({})).toBe('development');
    expect(() => gate.gate('reactor_transition_library', {})).not.toThrow();
  });
});
