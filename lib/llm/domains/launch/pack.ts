/** The Launch (Reactor) tagging domain pack. See ../domain-pack.ts. */

import type { DomainPack, DomainRunInput, DomainSession, DomainSessionInput } from '../domain-pack';
import { parseLaunchBrief, type LaunchRequirements } from './brief';
import { launchDomainContext, launchToolsContext } from './context';
import { launchExamplesPreamble, selectLaunchExamples } from './examples';
import { launchAlwaysOnTools, launchShortlistQuery, seedLaunchPlan } from './plan';
import { LaunchValidationGate, PUBLISH_TRANSITION_TOOL, type ResolvedStage } from './validation';

/** The PLATFORM_GROUPS key for Launch/Reactor tags — a platformFilter narrowed to it turns Launch mode on. */
const LAUNCH_PLATFORM_GROUP = 'Tags (Reactor)';
/** Groups that may ride along with the Launch group without making the run "not Launch" (grounding + the code-commit handoff). */
const LAUNCH_COMPANION_GROUPS = new Set(['Knowledge', 'GitHub']);

/**
 * Whether this run should ground on the Launch/Reactor object model: set
 * explicitly via opts.launchMode, or implied when the platform filter is
 * narrowed to the Launch/Reactor tag tools (plus Knowledge/GitHub). A filter
 * that merely still includes the Tags group alongside other platforms — e.g.
 * every box ticked but CJA — is not a Launch run. Non-Launch runs keep the
 * lean cached prefix.
 */
export function resolveLaunchMode(opts: Pick<DomainRunInput, 'launchMode' | 'platformFilter'>): boolean {
  if (opts.launchMode !== undefined) return opts.launchMode;
  const filter = opts.platformFilter ?? [];
  return filter.includes(LAUNCH_PLATFORM_GROUP) && filter.every((p) => p === LAUNCH_PLATFORM_GROUP || LAUNCH_COMPANION_GROUPS.has(p));
}

/**
 * Whether a call is a publish transition to a server-verified dev/staging
 * environment, which the user asked to run without an approval. Production
 * is refused by the gate before it runs, and an unknown stage stays gated:
 * a publish that can't be proven safe is not exempted.
 */
export function isVerifiedDevPublish(toolName: string, stage: ResolvedStage | undefined): boolean {
  return toolName === PUBLISH_TRANSITION_TOOL && (stage === 'development' || stage === 'staging');
}

/**
 * Per-run Launch setup:
 * - Phase 2: parse the free-text brief into typed requirements for a live
 *   run, so the shortlist query, the seeded plan and the examples are
 *   specialised to it. Callers can pass requirements to skip the parse.
 *   Fail-open: a parse failure runs the generic Launch flow.
 * - Phase 4: the validation gate (validation.ts) observes tool results to
 *   build property state and BLOCKS the library handoff until the
 *   structural / reference / dry-run checks pass. Live runs only.
 * - Phase 5: few-shot examples closest to the requirements, ahead of the
 *   request. Live runs only.
 * - Seeded plan: Launch runs follow a fixed backbone (read property state →
 *   ground against the KB → generate → validate → populate the library), so
 *   the plan comes from the template rather than the planner.
 */
async function startLaunchSession(input: DomainSessionInput): Promise<DomainSession> {
  let requirements = input.requirements as LaunchRequirements | undefined;
  const gate = input.live
    ? new LaunchValidationGate({ dryRun: input.dryRun, shadow: input.shadow, publishTarget: input.publishTarget })
    : undefined;
  if (input.live && !requirements) {
    try {
      requirements = await parseLaunchBrief(input.userInput, input.modelKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[agent] Launch brief parse failed; running without parsed requirements:', `[Launch brief parse] ${message}`);
    }
  }
  const preamble = input.live ? launchExamplesPreamble(selectLaunchExamples(requirements)) : '';
  return {
    shortlistQuery: launchShortlistQuery(input.userInput, requirements),
    seedPlan: seedLaunchPlan(requirements, input.publishEnabled),
    ...(preamble ? { messagePreamble: preamble } : {}),
    ...(gate
      ? {
          toolGate: gate,
          verifiesOutbound: (toolName: string, args: unknown) =>
            toolName === PUBLISH_TRANSITION_TOOL && isVerifiedDevPublish(toolName, gate.resolveStageFor(args)),
        }
      : {}),
    ...(requirements ? { requirements } : {}),
  };
}

export const launchPack: DomainPack = {
  id: 'launch',
  detect: resolveLaunchMode,
  // publishEnabled swaps only the publish-related lines; false keeps the
  // historical text byte-identical.
  promptContext: ({ publishEnabled }) => [launchDomainContext(publishEnabled), launchToolsContext(publishEnabled)],
  alwaysOnTools: ({ publishEnabled }) => launchAlwaysOnTools(publishEnabled),
  startSession: startLaunchSession,
};
