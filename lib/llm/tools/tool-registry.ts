/**
 * One profile per tool: everything the harness knows about a tool and how it
 * treats it, composed from the tool taxonomy (tool-taxonomy.ts), the approval
 * policy and the domain registry. Use it to answer "what is this tool, and
 * what happens when the model calls it?" in one place — for audits, the
 * /api/tools endpoint, and tests that pin the safety rules down.
 *
 * Read-only: the policy modules still make every decision; this module only
 * reports what they decide.
 */

import { domainOfTool, type DomainId } from '../domains';
import { approvalReason, type ApprovalReason } from './approval-policy';
import { isLocalTool } from './local-tools';
import {
  classifyTool,
  CREDENTIAL_TOOLS,
  isAdobeScoped,
  isKnowledgeTool,
  OUTBOUND_TOOLS,
  PLATFORM_GROUPS,
  SQL_TOOLS,
  toolMatchesPlatforms,
  type ToolAccessLevel,
} from './tool-taxonomy';

export interface ToolProfile {
  name: string;
  /** read / write / destructive: read-only runs drop write and destructive tools; dry-run describes destructive ones. */
  access: ToolAccessLevel;
  /** PLATFORM_GROUPS keys this tool matches (the UI's platform filter). */
  platforms: string[];
  /** The domain pack that owns it, if any. */
  domain?: DomainId;
  /** Sends data, code or credentials outside the platform, or publishes. */
  outbound: boolean;
  /** Its result is a credential. */
  credentials: boolean;
  /** Runs caller-supplied SQL. */
  runsSql: boolean;
  /** Knowledge search: never shown to the model, used for planning and error grounding. */
  knowledge: boolean;
  /** Executed by the harness itself rather than the MCP server. */
  local: boolean;
  /** Kept when ADOBE_TOOLS_ONLY is on (the default). */
  adobeScoped: boolean;
  /**
   * Whether a call waits for a person in autonomous mode:
   * an ApprovalReason, 'when-sql-writes' (depends on the statement), or 'never'.
   * Assisted mode also asks before every write; shadow mode dry-runs writes.
   */
  approval: ApprovalReason | 'when-sql-writes' | 'never';
}

export function describeTool(name: string): ToolProfile {
  const runsSql = SQL_TOOLS.has(name);
  const domain = domainOfTool(name);
  return {
    name,
    access: classifyTool(name),
    platforms: Object.keys(PLATFORM_GROUPS).filter((group) => toolMatchesPlatforms(name, [group])),
    ...(domain ? { domain } : {}),
    outbound: OUTBOUND_TOOLS.has(name),
    credentials: CREDENTIAL_TOOLS.has(name),
    runsSql,
    knowledge: isKnowledgeTool(name),
    local: isLocalTool(name),
    adobeScoped: isAdobeScoped(name),
    approval: runsSql ? 'when-sql-writes' : (approvalReason(name, {}) ?? 'never'),
  };
}

/** Profiles for a list of tool names, sorted by name. */
export function describeTools(names: Iterable<string>): ToolProfile[] {
  return [...new Set(names)].sort().map(describeTool);
}
