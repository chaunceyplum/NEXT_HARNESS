/**
 * The domain pack registry. The runtime and tool layer call these helpers
 * rather than importing a specific domain. See ./domain-pack.ts.
 */

import type {
  ActiveDomains,
  DomainLocalTool,
  DomainOptions,
  DomainPack,
  DomainRunInput,
  DomainSession,
  DomainSessionInput,
  ToolCallGate,
} from './domain-pack';
import { launchPack } from './launch/pack';
import { segmentsPack } from './segments/pack';

export type {
  ActiveDomains,
  DomainId,
  DomainLocalTool,
  DomainOptions,
  DomainPack,
  DomainRunInput,
  DomainSession,
  DomainSessionInput,
} from './domain-pack';
export { resolveLaunchMode } from './launch/pack';
export type { LaunchRequirements } from './launch/brief';

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

/**
 * Start every active pack's session and merge them into one: the first
 * shortlist query and seeded plan win (registry order), preambles are joined,
 * gates are chained, and an outbound call is verified if any pack verifies it.
 */
export async function startDomainSessions(active: Partial<ActiveDomains>, input: DomainSessionInput): Promise<DomainSession> {
  const sessions: DomainSession[] = [];
  for (const pack of DOMAIN_PACKS) {
    if (active[pack.id] && pack.startSession) sessions.push(await pack.startSession(input));
  }
  if (sessions.length <= 1) return sessions[0] ?? {};
  const gates = sessions.map((s) => s.toolGate).filter((g): g is ToolCallGate => Boolean(g));
  const preamble = sessions.map((s) => s.messagePreamble).filter(Boolean).join('\n\n');
  const verifiers = sessions.map((s) => s.verifiesOutbound).filter((v): v is NonNullable<DomainSession['verifiesOutbound']> => Boolean(v));
  return {
    shortlistQuery: sessions.find((s) => s.shortlistQuery)?.shortlistQuery,
    seedPlan: sessions.find((s) => s.seedPlan)?.seedPlan,
    ...(preamble ? { messagePreamble: preamble } : {}),
    ...(gates.length
      ? {
          toolGate: {
            gate: (name, args) => gates.forEach((g) => g.gate(name, args)),
            observe: (name, args, result) => gates.forEach((g) => g.observe(name, args, result)),
          },
        }
      : {}),
    ...(verifiers.length ? { verifiesOutbound: (name, args) => verifiers.some((v) => v(name, args)) } : {}),
    requirements: sessions.find((s) => s.requirements !== undefined)?.requirements,
  };
}

/** Every pack's pre-call check, run before each tool call of every run. Throws to refuse the call. */
export async function checkDomainToolCall(toolName: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<void> {
  for (const pack of DOMAIN_PACKS) await pack.checkToolCall?.(toolName, args, opts);
}

/** Tools the domains run locally, in registry order. */
export const DOMAIN_LOCAL_TOOLS: readonly DomainLocalTool[] = DOMAIN_PACKS.flatMap((p) => p.localTools ?? []);
