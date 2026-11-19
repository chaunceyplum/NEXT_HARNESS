/**
 * The domain pack registry. The runtime and tool layer call these helpers
 * rather than importing a specific domain. See ./domain-pack.ts.
 */

import type { ActiveDomains, DomainOptions, DomainPack, DomainRunInput } from './domain-pack';
import { launchPack } from './launch/pack';
import { segmentsPack } from './segments/pack';

export type { ActiveDomains, DomainId, DomainOptions, DomainPack, DomainRunInput } from './domain-pack';

/**
 * Every pack, in system-prompt order. The order is part of the cached prompt
 * prefix and the promptVersion fingerprint, so append new packs at the end.
 */
export const DOMAIN_PACKS: readonly DomainPack[] = [launchPack, segmentsPack];

/** Which packs are on for this run. */
export function resolveDomains(input: DomainRunInput): ActiveDomains {
  return Object.fromEntries(DOMAIN_PACKS.map((p) => [p.id, p.detect(input)])) as ActiveDomains;
}

/** The system-prompt blocks of every active pack, in registry order. */
export function domainPromptBlocks(active: Partial<ActiveDomains>, opts: DomainOptions): string[] {
  return DOMAIN_PACKS.filter((p) => active[p.id]).flatMap((p) => p.promptContext(opts));
}

/** The always-on tools every active pack adds, in registry order. */
export function domainAlwaysOnTools(active: Partial<ActiveDomains>, opts: DomainOptions): string[] {
  return DOMAIN_PACKS.filter((p) => active[p.id]).flatMap((p) => [...p.alwaysOnTools(opts)]);
}
