/**
 * TASK 9: Tool policy layer — classifies every tool as read, write, or
 * destructive based on its name, and enforces per-request access controls
 * before tools reach the model.
 *
 * Classification (see classifyTool): MCP tool names carry a server prefix
 * (adobe_delete_segment, reactor_create_rule, msb_github_merge_pr), so the
 * name is split on "_" and the FIRST recognised verb token decides:
 *
 *   read        get, list, search, read, preview, health, find, info, ...
 *   write       create, update, upload, enable, disable, install, build,
 *               commit, copy, cancel, execute, run, ...
 *   destructive delete, abort, trash, purge, plus exact overrides for
 *               msb_github_merge_pr (irreversible) and *_create_privacy_job
 *               (submits an irreversible GDPR/CCPA delete)
 *
 * "First verb wins" keeps nouns from misclassifying a tool: adobe_list_merge_
 * policies is a read (list comes before merge), flow_get_run is a read.
 * A name with no recognised verb fails closed as 'write', so a new tool
 * never silently slips through read-only mode.
 *
 * Two policy modes (set via BUILD_POLICY env var or per-request; a request
 * can only tighten the env setting, never loosen it):
 *
 *   'full'      All tools available (default).
 *   'read-only' Only read-classified tools are included in the tool set.
 *               Write and destructive tools are removed before the model
 *               ever sees them — it's structurally impossible to call them,
 *               not just rule-based.
 *
 * Additionally, TOOL_DRY_RUN=true (or dryRun on the request) wraps every destructive tool's execute
 * function so it returns a description of what it *would* do without
 * actually calling the MCP server. Useful for demos and staging environments.
 */

import { tool, jsonSchema, type ToolSet } from 'ai';
import { classifyTool, type ToolAccessLevel } from './tool-taxonomy';

export { classifyTool, type ToolAccessLevel };

/**
 * A per-run gate around every tool call, supplied by a domain session
 * (lib/llm/domains). gate() runs before the call and throws to refuse it;
 * observe() sees each result (or undefined for a dry-run description).
 * Launch's validation gate is one: it blocks a library handoff that fails
 * validation. Defined here, in the tool layer, so this layer never imports a
 * domain.
 */
export interface ToolCallGate {
  gate(toolName: string, args: unknown): void;
  observe(toolName: string, args: unknown, result: unknown): void;
}

// ── Policy enforcement ────────────────────────────────────────────────────────

export type PolicyMode = 'full' | 'read-only';

/**
 * Read the active policy mode from the environment.
 * BUILD_POLICY=read-only disables all write and destructive tools globally.
 */
export function getDefaultPolicy(): PolicyMode {
  const v = process.env.BUILD_POLICY?.trim().toLowerCase();
  return v === 'read-only' ? 'read-only' : 'full';
}

/**
 * Read the dry-run flag from the environment.
 * TOOL_DRY_RUN=true wraps destructive tools to describe what they would do
 * without actually calling the MCP server.
 */
export function isDryRunEnabled(): boolean {
  return process.env.TOOL_DRY_RUN?.trim().toLowerCase() === 'true';
}

/**
 * Filter and/or wrap a ToolSet according to the given policy.
 *
 * In 'read-only' mode: removes every tool whose access level is 'write' or
 * 'destructive'. The model structurally cannot call them.
 *
 * In 'full' mode with dryRun=true: wraps destructive tools so their execute
 * function returns a dry-run description instead of calling the MCP server.
 *
 * Always injects a 'policy_info' tool so the model can query the active policy
 * if it's confused about why a tool is missing.
 */
/**
 * The effective policy for a run. The env settings are a floor: a per-request
 * value can make a run stricter (read-only, dry-run) but never looser than
 * the deployment allows, so a request body of {"policy":"full","dryRun":false}
 * can't bypass them.
 */
export function resolvePolicy(opts: { mode?: PolicyMode; dryRun?: boolean } = {}): { mode: PolicyMode; dryRun: boolean } {
  return {
    mode: getDefaultPolicy() === 'read-only' || opts.mode === 'read-only' ? 'read-only' : 'full',
    dryRun: isDryRunEnabled() || opts.dryRun === true,
  };
}

export function applyToolPolicy(
  tools: ToolSet,
  opts: { mode?: PolicyMode; dryRun?: boolean; dryRunWrites?: boolean; toolGate?: ToolCallGate } = {}
): ToolSet {
  const { mode, dryRun } = resolvePolicy(opts);
  // Shadow rollout (approval-policy.ts): writes are intercepted too, not just destructive calls.
  const dryRunWrites = opts.dryRunWrites === true;
  const toolGate = opts.toolGate;

  const result: ToolSet = {};

  for (const [name, def] of Object.entries(tools)) {
    const level = classifyTool(name);

    // Read-only mode: drop write and destructive tools entirely
    if (mode === 'read-only' && (level === 'write' || level === 'destructive')) {
      continue;
    }

    // Dry-run mode: wrap destructive tools (and, in shadow mode, writes) to describe instead of execute
    if ((dryRun && level === 'destructive') || (dryRunWrites && level !== 'read')) {
      const originalDesc = (def as { description?: string }).description ?? name;
      result[name] = tool({
        description: `[DRY RUN — will NOT execute] ${originalDesc}`,
        // Accept any object so the model can still form a valid call
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: 'object',
          additionalProperties: true,
        }),
        execute: async (input: unknown) => {
          // Phase 4 (dry-run populate): the real MCP write never runs here, so
          // a server-side rejection can't surface. The Launch gate stands in
          // for it — validating the handoff against the structural/reference
          // invariants and throwing (so the model fixes it) before this
          // returns the "would do" description. No-op for a non-handoff tool.
          toolGate?.gate(name, input);
          // Still observe the (not-executed) call so a dry-run/shadow create
          // of a rule component / data element is remembered for a later
          // handoff's reference check — there's no server result, so only the
          // arguments are read (see LaunchValidationGate.observe).
          toolGate?.observe(name, input, undefined);
          return {
            _dryRun: true,
            tool: name,
            wouldExecuteWith: input,
            message:
              `DRY RUN: ${name} was intercepted and NOT sent to the MCP server. ` +
              (dryRunWrites
                ? 'This deployment is in shadow rollout mode (ROLLOUT_MODE=shadow): writes are logged, never executed.'
                : `Remove TOOL_DRY_RUN=true from your environment to execute real destructive operations.`),
          };
        },
      });
      continue;
    }

    result[name] = def;
  }

  // Always-on policy info tool so the model understands why tools are absent
  result['policy_info'] = tool({
    description:
      'Returns the active tool policy for this run. Call this if you think a needed tool should be available but is not.',
    inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: false }),
    execute: async () => ({
      mode,
      dryRun,
      shadow: dryRunWrites,
      message:
        mode === 'read-only'
          ? 'This run is in READ-ONLY mode. Write and destructive tools have been removed. Only read/search/query tools are available.'
          : dryRunWrites
            ? 'SHADOW mode — write and destructive tools describe what they would do but never execute.'
            : dryRun
              ? 'Destructive tools are in DRY-RUN mode — they will describe what they would do but not execute.'
              : 'Full access. All tools are available.',
    }),
  });

  return result;
}
