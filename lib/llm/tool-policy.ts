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

// ── Classification ────────────────────────────────────────────────────────────

export type ToolAccessLevel = 'read' | 'write' | 'destructive';

/** Exact-name overrides, checked before verb detection. */
const EXACT_LEVELS: Record<string, ToolAccessLevel> = {
  msb_github_merge_pr: 'destructive',      // merging a PR is irreversible
  query_rag_db: 'read',                    // "query" is a verb here, but a server prefix in query_run etc.
  find_tools: 'read',                      // synthetic (agent.ts)
  policy_info: 'read',                     // synthetic (below)
};

const DESTRUCTIVE_VERBS = new Set(['delete', 'abort', 'trash', 'purge']);

const WRITE_VERBS = new Set([
  'create', 'update', 'upload', 'complete', 'enable', 'disable', 'install',
  'build', 'transition', 'add', 'remove', 'commit', 'copy', 'cancel',
  'generate', 'execute', 'run', 'publish', 'share', 'merge',
]);

const READ_VERBS = new Set([
  'get', 'list', 'search', 'read', 'preview', 'describe', 'health', 'find', 'info',
]);

export function classifyTool(name: string): ToolAccessLevel {
  const exact = EXACT_LEVELS[name];
  if (exact) return exact;
  // Submitting a privacy job deletes customer data irreversibly, even though
  // its verb is "create".
  if (name.endsWith('create_privacy_job')) return 'destructive';

  for (const token of name.split('_')) {
    if (DESTRUCTIVE_VERBS.has(token)) return 'destructive';
    if (WRITE_VERBS.has(token)) return 'write';
    if (READ_VERBS.has(token)) return 'read';
  }
  return 'write';
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
export function applyToolPolicy(
  tools: ToolSet,
  opts: { mode?: PolicyMode; dryRun?: boolean } = {}
): ToolSet {
  // The env settings are a floor: a per-request value can make a run stricter
  // (read-only, dry-run) but never looser than the deployment allows, so a
  // request body of {"policy":"full","dryRun":false} can't bypass them.
  const mode: PolicyMode =
    getDefaultPolicy() === 'read-only' || opts.mode === 'read-only' ? 'read-only' : 'full';
  const dryRun = isDryRunEnabled() || opts.dryRun === true;

  const result: ToolSet = {};

  for (const [name, def] of Object.entries(tools)) {
    const level = classifyTool(name);

    // Read-only mode: drop write and destructive tools entirely
    if (mode === 'read-only' && (level === 'write' || level === 'destructive')) {
      continue;
    }

    // Dry-run mode: wrap destructive tools to describe instead of execute
    if (dryRun && level === 'destructive') {
      const originalDesc = (def as { description?: string }).description ?? name;
      result[name] = tool({
        description: `[DRY RUN — will NOT execute] ${originalDesc}`,
        // Accept any object so the model can still form a valid call
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: 'object',
          additionalProperties: true,
        }),
        execute: async (input: unknown) => ({
          _dryRun: true,
          tool: name,
          wouldExecuteWith: input,
          message:
            `DRY RUN: ${name} was intercepted and NOT sent to the MCP server. ` +
            `Remove TOOL_DRY_RUN=true from your environment to execute real destructive operations.`,
        }),
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
      message:
        mode === 'read-only'
          ? 'This run is in READ-ONLY mode. Write and destructive tools have been removed. Only read/search/query tools are available.'
          : dryRun
            ? 'Destructive tools are in DRY-RUN mode — they will describe what they would do but not execute.'
            : 'Full access. All tools are available.',
    }),
  });

  return result;
}
