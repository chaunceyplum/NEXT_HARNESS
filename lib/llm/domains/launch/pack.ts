/** The Launch (Reactor) tagging domain pack. See ../domain-pack.ts. */

import type { DomainPack, DomainRunInput } from '../domain-pack';
import { launchDomainContext, launchToolsContext } from './context';
import { launchAlwaysOnTools } from './plan';

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

export const launchPack: DomainPack = {
  id: 'launch',
  detect: resolveLaunchMode,
  // publishEnabled swaps only the publish-related lines; false keeps the
  // historical text byte-identical.
  promptContext: ({ publishEnabled }) => [launchDomainContext(publishEnabled), launchToolsContext(publishEnabled)],
  alwaysOnTools: ({ publishEnabled }) => launchAlwaysOnTools(publishEnabled),
};
