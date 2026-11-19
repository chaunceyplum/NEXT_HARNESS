import { describe, expect, it } from 'vitest';
import { isVerifiedDevPublish, launchPack } from './pack';
import { LaunchValidationGate } from './validation';
import { seedLaunchPlan, launchShortlistQuery } from './plan';
import type { LaunchRequirements } from './brief';

describe('isVerifiedDevPublish', () => {
  it('verifies a publish transition to a development or staging stage', () => {
    expect(isVerifiedDevPublish('reactor_transition_library', 'development')).toBe(true);
    expect(isVerifiedDevPublish('reactor_transition_library', 'staging')).toBe(true);
  });

  it('never verifies production, an unknown stage or no stage', () => {
    expect(isVerifiedDevPublish('reactor_transition_library', 'production')).toBe(false);
    expect(isVerifiedDevPublish('reactor_transition_library', 'unknown')).toBe(false);
    expect(isVerifiedDevPublish('reactor_transition_library', undefined)).toBe(false);
  });

  it('never verifies any other outbound tool, even with a dev/staging stage', () => {
    expect(isVerifiedDevPublish('reactor_build_library', 'staging')).toBe(false);
    expect(isVerifiedDevPublish('msb_github_commit_code', 'development')).toBe(false);
  });
});

describe('launchPack.startSession', () => {
  const base = { userInput: 'add a page-load rule', publishEnabled: false, dryRun: false, shadow: false };

  it('on the eval path: seeded plan and shortlist query, but no gate, parse or examples', async () => {
    const session = await launchPack.startSession!({ ...base, live: false });
    expect(session.toolGate).toBeUndefined();
    expect(session.verifiesOutbound).toBeUndefined();
    expect(session.messagePreamble).toBeUndefined();
    expect(session.seedPlan).toEqual(seedLaunchPlan(undefined, false));
    expect(session.shortlistQuery).toBe(launchShortlistQuery(base.userInput, undefined));
  });

  it('on a live run with requirements supplied: a validation gate, and no brief parse', async () => {
    const requirements: LaunchRequirements = { summary: 'page-load rule', target: { propertyName: null, libraryName: null }, rules: [], dataElements: [], dataLayerReferences: [], openQuestions: [] };
    const session = await launchPack.startSession!({ ...base, live: true, requirements });
    expect(session.toolGate).toBeInstanceOf(LaunchValidationGate);
    expect(session.requirements).toBe(requirements);
    // An unverifiable transition (no observed environment) is not exempted.
    expect(session.verifiesOutbound!('reactor_transition_library', { action: 'submit' })).toBe(false);
    expect(session.verifiesOutbound!('reactor_build_library', {})).toBe(false);
  });
});
