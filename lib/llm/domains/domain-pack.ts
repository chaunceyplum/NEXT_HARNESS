/**
 * A domain pack bundles the Adobe domain knowledge one kind of run needs, so
 * the generic agent machinery (lib/llm/runtime, lib/llm/tools) asks the
 * registry (./index.ts) instead of hard-coding each domain.
 *
 * Every pack answers the same three questions:
 *   - detect: does this run get the pack? (an explicit request flag wins,
 *     otherwise the pack infers it from the request)
 *   - promptContext: which blocks go into the cached system prompt
 *   - alwaysOnTools: which tools skip the shortlist and are always offered
 *
 * Steps that only one domain has (Launch's brief parsing, seeded plan,
 * worked examples and validation gate; the segment field check in the tool
 * layer) stay in that domain's own modules and are called where they apply.
 *
 * To add a domain: write domains/<name>/pack.ts implementing DomainPack, add
 * it to DOMAIN_PACKS, and add a `<name>Mode?: boolean` request flag next to
 * launchMode / segmentMode. Prompt text must be stable (no per-request data)
 * because it rides the prompt-cache prefix.
 */

export type DomainId = 'launch' | 'segments';

/** What a pack may look at to decide whether a run is in its domain. */
export interface DomainRunInput {
  userInput: string;
  platformFilter?: string[];
  /** Explicit request flags: set → wins over inference; unset → infer. */
  launchMode?: boolean;
  segmentMode?: boolean;
}

/** Per-run options that change a pack's prompt text or tools. */
export interface DomainOptions {
  /** Launch only: the run may publish to a dev/staging environment. */
  publishEnabled: boolean;
}

export interface DomainPack {
  id: DomainId;
  /** Whether this run is in the pack's domain. */
  detect(input: DomainRunInput): boolean;
  /** Blocks appended to the cached system prompt, in order. Stable text only. */
  promptContext(opts: DomainOptions): string[];
  /** Tools added to the always-on set (still filtered to the run's catalog). */
  alwaysOnTools(opts: DomainOptions): readonly string[];
}

/** Which packs are on for a run. */
export type ActiveDomains = Record<DomainId, boolean>;
