/**
 * Which tool calls pause for a human decision before they run.
 *
 * tool-policy.ts classifies tools by the verb in their name (read / write /
 * destructive), which decides what a run can see at all. That verb is a poor
 * guide to risk for a few tools, so approval is decided per call here:
 *
 *   - Destructive tools (delete_*, abort_*, merge_pr, privacy jobs): always.
 *   - execute_sql: unless the statement is a single read-only query. The MCP
 *     server runs it with full read/write/DDL rights, so a `DROP TABLE` would
 *     otherwise go through as an ordinary "write".
 *   - Outbound tools: anything that sends data or code out of the platform
 *     (commits, PRs, export jobs, destination dataflows, callbacks/webhooks,
 *     SFTP hosts) or publishes a Launch library. An agent that reads private
 *     data and untrusted content can be steered into exfiltrating it through
 *     one of these (the "lethal trifecta"); gating them removes that leg.
 *   - Credential-returning reads (landing-zone credentials, secrets): the
 *     result would put a secret into the model's context.
 *
 * Rollout modes widen that set (see RolloutMode). The mode comes from
 * ROLLOUT_MODE and can be tightened, never loosened, per request.
 */

import { classifyTool } from './tool-policy';

export type RolloutMode = 'autonomous' | 'assisted' | 'shadow';

/**
 * - autonomous: only the calls listed above need approval (default).
 * - assisted:   every write or destructive call needs approval.
 * - shadow:     every write or destructive call is dry-run (never executed);
 *               sensitive reads still need approval.
 */
const MODE_STRICTNESS: Record<RolloutMode, number> = { autonomous: 0, assisted: 1, shadow: 2 };

export function parseRolloutMode(value: unknown): RolloutMode | undefined {
  return typeof value === 'string' && value in MODE_STRICTNESS ? (value as RolloutMode) : undefined;
}

/** The stricter of ROLLOUT_MODE and the per-request mode. */
export function resolveRolloutMode(requested?: RolloutMode): RolloutMode {
  const env = parseRolloutMode(process.env.ROLLOUT_MODE?.trim().toLowerCase()) ?? 'autonomous';
  if (!requested) return env;
  return MODE_STRICTNESS[requested] > MODE_STRICTNESS[env] ? requested : env;
}

/** Tools that move data, code, or credentials outside the platform. */
const OUTBOUND_TOOLS = new Set([
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
const CREDENTIAL_TOOLS = new Set(['flow_get_landing_zone_credentials', 'reactor_get_secret', 'reactor_list_secrets']);

export type ApprovalReason = 'destructive' | 'sql-write' | 'outbound' | 'credentials' | 'assisted-mode';

const SQL_READ_START = new Set(['select', 'with', 'explain', 'show', 'values', 'table']);

/**
 * Keywords that make a statement something other than a plain read. Checked
 * anywhere in the statement (after literals and comments are stripped), so a
 * data-modifying CTE (`WITH x AS (DELETE …) SELECT …`) or `SELECT … INTO`
 * still counts as a write. Errs toward asking.
 */
const SQL_WRITE_WORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy|call|do|vacuum|refresh|reindex|cluster|lock|set|reset|into|listen|notify|prepare|execute|load)\b/i;

/** Server-side functions with side effects (session control, file/large-object IO, remote SQL). */
const SQL_SIDE_EFFECT_FUNCS = /\b(pg_\w+|lo_\w+|dblink\w*|set_config|nextval|setval)\s*\(/i;

/** Remove string literals, quoted identifiers, dollar-quoted bodies, and comments. */
function stripSql(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** True only for a single statement that can't change anything. Anything unparseable is treated as a write. */
export function isReadOnlySql(sql: unknown): boolean {
  if (typeof sql !== 'string') return false;
  const statements = stripSql(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;
  const stmt = statements[0];
  const first = stmt.match(/^\(*\s*([A-Za-z]+)/)?.[1]?.toLowerCase();
  if (!first || !SQL_READ_START.has(first)) return false;
  return !SQL_WRITE_WORDS.test(stmt) && !SQL_SIDE_EFFECT_FUNCS.test(stmt);
}

function sqlOf(input: unknown): unknown {
  return input && typeof input === 'object' ? (input as { sql?: unknown }).sql : undefined;
}

/**
 * Why this call needs a human decision, or undefined if it can run as is.
 * `toolName`/`input` are the effective call (call_tool already unwrapped).
 * `dryRun` means destructive tools are wrapped and won't execute.
 */
export function approvalReason(
  toolName: string,
  input: unknown,
  opts: { mode?: RolloutMode; dryRun?: boolean } = {}
): ApprovalReason | undefined {
  const mode = opts.mode ?? 'autonomous';
  const level = classifyTool(toolName);
  // Shadow mode and dry-run both replace these with a description; nothing executes.
  const neutralised = mode === 'shadow' ? level !== 'read' : opts.dryRun === true && level === 'destructive';

  if (CREDENTIAL_TOOLS.has(toolName)) return 'credentials';
  if (neutralised) return undefined;
  if (level === 'destructive') return 'destructive';
  if (toolName === 'execute_sql' && !isReadOnlySql(sqlOf(input))) return 'sql-write';
  if (OUTBOUND_TOOLS.has(toolName)) return 'outbound';
  if (mode === 'assisted' && level === 'write') return 'assisted-mode';
  return undefined;
}

export const APPROVAL_REASON_TEXT: Record<ApprovalReason, string> = {
  destructive: 'irreversible (delete/abort/merge/privacy job)',
  'sql-write': 'SQL that is not a single read-only query',
  outbound: 'sends data or code outside the platform, or publishes',
  credentials: 'returns credentials',
  'assisted-mode': 'assisted rollout mode: every write is approved by a person',
};
