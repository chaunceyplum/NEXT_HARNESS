/**
 * TASK 9: Tool policy layer — classifies every tool as read, write, or
 * destructive based on its name, and enforces per-request access controls
 * before tools reach the model.
 *
 * Three access levels:
 *
 *   read        get_*, list_*, search_*, query_*, describe_*, health_*,
 *               github_read_file, github_list_directory, find_tools
 *
 *   write       create_*, update_*, upload_*, complete_*, enable_*, disable_*,
 *               install_*, build_*, publish_*, commit_code, create_branch,
 *               create_pr, add_resources_*, remove_resources_*, transition_*
 *
 *   destructive delete_*, abort_*, merge_* (merging a PR is irreversible),
 *               privacy jobs (create_privacy_job — irreversible data deletion),
 *               delete_profile_entity
 *
 * Two policy modes (set via BUILD_POLICY env var or per-request):
 *
 *   'full'      All tools available (default).
 *   'read-only' Only read-classified tools are included in the tool set.
 *               Write and destructive tools are removed before the model
 *               ever sees them — it's structurally impossible to call them,
 *               not just rule-based.
 *
 * Additionally, TOOL_DRY_RUN=true wraps every destructive tool's execute
 * function so it returns a description of what it *would* do without
 * actually calling the MCP server. Useful for demos and staging environments.
 */

import { tool, jsonSchema, type ToolSet } from 'ai';

// ── Classification ────────────────────────────────────────────────────────────

export type ToolAccessLevel = 'read' | 'write' | 'destructive';

/** Name prefixes / exact matches for each access level. Checked in order: destructive first. */
const DESTRUCTIVE_PREFIXES = [
  'delete_',
  'abort_',
  'merge_',           // msb_github_merge_pr — irreversible once merged
];

const DESTRUCTIVE_EXACT = new Set([
  'create_privacy_job',      // submits a GDPR/CCPA delete — irreversible
  'delete_profile_entity',   // deletes a stitched profile record
]);

const WRITE_PREFIXES = [
  'create_',
  'update_',
  'upload_',
  'complete_',
  'enable_',
  'disable_',
  'install_',
  'build_',
  'transition_',
  'add_resources',
  'remove_resources',
];

const WRITE_EXACT = new Set([
  'msb_github_commit_code',
  'msb_github_create_branch',
  'msb_github_create_pr',
]);

export function classifyTool(name: string): ToolAccessLevel {
  if (DESTRUCTIVE_EXACT.has(name)) return 'destructive';
  if (DESTRUCTIVE_PREFIXES.some((p) => name.startsWith(p))) return 'destructive';
  if (WRITE_EXACT.has(name)) return 'write';
  if (WRITE_PREFIXES.some((p) => name.startsWith(p))) return 'write';
  return 'read';
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
  const mode = opts.mode ?? getDefaultPolicy();
  const dryRun = opts.dryRun ?? isDryRunEnabled();

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
