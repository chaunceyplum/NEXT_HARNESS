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
 * and may add optional hooks:
 *   - startSession: per-run setup for an active pack (Launch parses the brief
 *     and builds its validation gate); the session then supplies the
 *     shortlist query, a seeded plan, a message preamble, a tool-call gate
 *     and approval verdicts
 *   - checkToolCall: a check run before EVERY tool call of every run, active
 *     or not, so a write in the domain is safe even when the run wasn't
 *     detected as one (segments: the real-fields-only PQL check)
 *   - localTools: tools the harness runs itself rather than the MCP server
 *
 * The runtime and the tool layer only talk to domains through the registry
 * (./index.ts); they never import a domain's own modules.
 *
 * To add a domain: write domains/<name>/pack.ts implementing DomainPack, add
 * it to DOMAIN_PACKS, and add a `<name>Mode?: boolean` request flag next to
 * launchMode / segmentMode. Prompt text must be stable (no per-request data)
 * because it rides the prompt-cache prefix.
 */

import type { McpToolDefinition } from '../tools/tool-catalog';
import type { ToolCallGate } from '../tools/tool-policy';
import type { Plan } from '../runtime/planner';

export type { ToolCallGate };

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

/** What an active pack's per-run setup can see. */
export interface DomainSessionInput extends DomainOptions {
  userInput: string;
  /** Model key for any setup model calls (e.g. Launch brief parsing). */
  modelKey?: string;
  /**
   * A live run against the MCP server. False on the eval path (scripted
   * tools), where packs skip network setup, gates and examples.
   */
  live: boolean;
  /** Tool policy: destructive calls are described, not executed. */
  dryRun: boolean;
  /** Rollout mode 'shadow': every write is described, not executed. */
  shadow: boolean;
  /** Launch only: where a publish may go. */
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string };
  /** Launch only: caller-supplied parsed requirements (skips the brief parse). */
  requirements?: unknown;
}

/**
 * Per-run state an active pack hands back to the runtime. Every field is
 * optional; the runtime applies whichever are present.
 */
export interface DomainSession {
  /** Query for the tool shortlist and the planning knowledge lookup. Defaults to the request. */
  shortlistQuery?: string;
  /** A fixed plan to use instead of asking the planner. */
  seedPlan?: Plan;
  /** Text put ahead of the first user message, after the plan and knowledge context. */
  messagePreamble?: string;
  /** Wraps every tool call: gate() throws to refuse, observe() sees results. */
  toolGate?: ToolCallGate;
  /**
   * The domain has verified this outbound call is safe to run without a
   * person (Launch: a publish transition to a server-verified dev/staging
   * environment). Anything not verified keeps its normal approval rules.
   */
  verifiesOutbound?(toolName: string, input: unknown): boolean;
  /** Parsed requirements, for callers that report them. */
  requirements?: unknown;
}

/** A tool the harness executes itself (no MCP round trip). */
export interface DomainLocalTool {
  definition: McpToolDefinition;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface DomainPack {
  id: DomainId;
  /** Whether this run is in the pack's domain. */
  detect(input: DomainRunInput): boolean;
  /** Blocks appended to the cached system prompt, in order. Stable text only. */
  promptContext(opts: DomainOptions): string[];
  /** Tools added to the always-on set (still filtered to the run's catalog). */
  alwaysOnTools(opts: DomainOptions): readonly string[];
  /** Per-run setup, called only when the pack is active. */
  startSession?(input: DomainSessionInput): Promise<DomainSession>;
  /** Runs before every tool call of every run; throws to refuse the call. */
  checkToolCall?(toolName: string, args: Record<string, unknown>, opts: { signal?: AbortSignal }): Promise<void>;
  /** Tools this domain runs locally. */
  localTools?: readonly DomainLocalTool[];
}

/** Which packs are on for a run. */
export type ActiveDomains = Record<DomainId, boolean>;
