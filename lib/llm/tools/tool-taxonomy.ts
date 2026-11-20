/**
 * The tool taxonomy: every hand-maintained fact about the harness's tools in
 * one module. Access level (read / write / destructive), outbound, credential
 * and SQL tools, platform groups, knowledge-search tools and the Adobe scope.
 *
 * Gathered here from tool-policy.ts, approval-policy.ts and tool-catalog.ts,
 * which import (and re-export) what they used to define, so behaviour is
 * unchanged. tool-registry.ts composes these into one profile per tool.
 * Pure data and pure functions: no imports, so anything may depend on it.
 */

// ── Classification ────────────────────────────────────────────────────────────

export type ToolAccessLevel = 'read' | 'write' | 'destructive';

/** Exact-name overrides, checked before verb detection. */
export const EXACT_LEVELS: Record<string, ToolAccessLevel> = {
  msb_github_merge_pr: 'destructive',      // merging a PR is irreversible
  query_rag_db: 'read',                    // "query" is a verb here, but a server prefix in query_run etc.
  intake_query: 'read',                    // mcp rejects anything but SELECT/WITH server-side
  find_tools: 'read',                      // synthetic (agent.ts)
  call_tool: 'write',                      // synthetic proxy (agent.ts) — classify its target via effectiveToolName
  policy_info: 'read',                     // synthetic (below)
  update_plan: 'read',                     // synthetic (planner.ts) — only updates in-memory plan state
  revise_plan: 'read',                     // synthetic (planner.ts)
};

export const DESTRUCTIVE_VERBS = new Set(['delete', 'abort', 'trash', 'purge']);

export const WRITE_VERBS = new Set([
  'create', 'update', 'upload', 'complete', 'enable', 'disable', 'install',
  'build', 'transition', 'add', 'remove', 'commit', 'copy', 'cancel',
  'generate', 'execute', 'run', 'publish', 'share', 'merge',
]);

export const READ_VERBS = new Set([
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

// ── Approval-relevant sets ────────────────────────────────────────────────────

/** Tools that move data, code, or credentials outside the platform. */
export const OUTBOUND_TOOLS = new Set([
  'msb_github_commit_code',
  'msb_github_create_pr',
  'msb_github_create_branch',
  'adobe_create_export_job',
  'destination_create_base_connection',
  'destination_update_base_connection',
  'destination_create_target_connection',
  'destination_update_target_connection',
  'destination_create_dataflow',
  'destination_update_dataflow',
  'destination_update_dataflow_audiences',
  'reactor_create_callback',
  'reactor_update_callback',
  'reactor_create_host',
  'reactor_update_host',
  'reactor_build_library',
  'reactor_transition_library',
]);

/** Reads whose result is a credential. */
export const CREDENTIAL_TOOLS = new Set(['flow_get_landing_zone_credentials', 'reactor_get_secret', 'reactor_list_secrets']);

/** Tools that run caller-supplied SQL: a write statement needs a human decision. */
export const SQL_TOOLS = new Set(['execute_sql', 'intake_execute_sql']);

// ── Platforms and scope ───────────────────────────────────────────────────────

/**
 * Non-Adobe integrations the harness currently has no use for. As of the
 * last live tools/list check (Aug 2026), the connected MCP server doesn't
 * actually expose any aws_/databricks_/snowflake_-prefixed tools or the
 * named search/pattern tools below — so today this filter is a no-op
 * defensive guard, not an active exclusion. It's kept (rather than deleted)
 * so that if a future server redeploy brings AWS/data-eng tools back into
 * the catalog, they stay excluded by default instead of silently competing
 * for shortlist slots against the Adobe tools every request here actually
 * needs — verify this list against a fresh tools/list before relying on it
 * to hide anything.
 *
 * Filtered out of the catalog entirely (not just excluded from the
 * shortlist) so this is enforced regardless of embedding/keyword scoring,
 * and so an always-on tool from one of these categories would silently
 * become unavailable too — agent.ts already does
 * `ALWAYS_ON_TOOLS.filter((name) => catalogByName.has(name))`.
 *
 * Set ADOBE_TOOLS_ONLY=false to disable this filter without a code change.
 */
export const NON_ADOBE_TOOL_PREFIXES = ['aws_', 'databricks_', 'snowflake_'];
export const NON_ADOBE_TOOL_NAMES = new Set([
  'search_aws_knowledge',
  'search_data_eng_knowledge',
  'search_braze_knowledge',
  'search_zeta_knowledge',
  'search_all_agents',
  'aws_architecture_pattern',
  'aws_recommend_services',
  'data_sql_pattern',
  'data_pipeline_pattern',
  'data_compare_platforms',
]);

export function isAdobeToolsOnlyEnabled(): boolean {
  return process.env.ADOBE_TOOLS_ONLY !== 'false';
}

export function isAdobeScoped(name: string): boolean {
  if (NON_ADOBE_TOOL_NAMES.has(name)) return false;
  return !NON_ADOBE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Platform groupings for UI-driven tool filtering. Each entry maps a display
 * label to an array of patterns: strings ending with '_' are prefix matches;
 * others are exact name matches. All groups are enabled by default.
 */
export const PLATFORM_GROUPS: Record<string, string[]> = {
  'AEP Core': ['adobe_', 'aep_find_profile_fields'],
  'CJA': ['cja_'],
  'Tags (Reactor)': ['reactor_'],
  'Data Prep': ['dataprep_'],
  'Sources': ['source_'],
  'Destinations': ['destination_'],
  'Flow Service': ['flow_'],
  'Query Service': ['query_'],
  'GitHub': ['github_', 'msb_github_'],
  'Knowledge': ['search_adobe_knowledge', 'query_rag_db', 'knowledge_base_health'],
};

/** Returns true if `toolName` belongs to any of the named `platforms`. */
export function toolMatchesPlatforms(toolName: string, platforms: string[]): boolean {
  for (const platform of platforms) {
    const patterns = PLATFORM_GROUPS[platform];
    if (!patterns) continue;
    for (const pattern of patterns) {
      if (pattern.endsWith('_') ? toolName.startsWith(pattern) : toolName === pattern) return true;
    }
  }
  return false;
}

// ── Knowledge-search tools ────────────────────────────────────────────────────

/**
 * Knowledge-search tools used to ground a retry. Never wrapped in their own
 * retry logic (that would recurse) and never chosen as the RAG tool for
 * themselves. Verified present in the live MCP catalog, Aug 2026.
 */
export const RAG_TOOLS = new Set([
  'search_adobe_knowledge',
  'search_all_agents',
  'query_rag_db',
  'knowledge_base_health',
]);

/**
 * Whether `name` is a knowledge-search tool. These are never handed to the
 * model: retrieval happens only at the planning stage (planning-retrieval.ts)
 * and on tool errors (executeMcpToolWithRetry), not on the model's say-so.
 */
export function isKnowledgeTool(name: string): boolean {
  return RAG_TOOLS.has(name);
}
