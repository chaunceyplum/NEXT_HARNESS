/** Picks the tool set a run sees: policy, platform filter, shortlist and discovery tools. */

import { type ToolSet } from 'ai';
import {
  buildAiTools,
  getMcpToolCatalog,
  isKnowledgeTool,
  toolMatchesPlatforms,
  type RagJudgmentSink,
} from '../tools/tool-catalog';
import { buildDiscoveryTools } from '../tools/tool-discovery';
import { shortlistTools } from '../tools/tool-retrieval';
import { ALWAYS_ON_TOOLS, stage } from './agent-core';
import { applyToolPolicy, type PolicyMode } from '../tools/tool-policy';
import { applyActionGuards } from '../quality/guardrails';
import { domainAlwaysOnTools, type ActiveDomains } from '../domains';
import type { ToolCallGate } from '../tools/tool-policy';

// ── Tool selection ────────────────────────────────────────────────────────────

interface LiveToolSelection {
  /** What the model sees all run: always-on + shortlist + policy_info + find_tools + call_tool. */
  tools: ToolSet;
  /** Always-on tools plus the semantic shortlist (the directly-visible catalog tools). */
  toolsConsidered: string[];
}

export async function selectLiveTools(
  userInput: string,
  toolShortlistSize: number,
  toolRetries: number,
  policy: { mode?: PolicyMode; dryRun?: boolean; dryRunWrites?: boolean },
  ragJudgmentSink: RagJudgmentSink,
  platformFilter?: string[],
  domains: {
    active: Partial<ActiveDomains>;
    publishEnabled?: boolean;
    /** The domain session's shortlist query (Launch: request + parsed requirements). */
    shortlistQuery?: string;
    toolGate?: ToolCallGate;
  } = { active: {} }
): Promise<LiveToolSelection> {
  const rawCatalog = await stage('MCP tool catalog (tools/list)', () => getMcpToolCatalog());
  // Knowledge tools are always kept in the catalog, whatever platforms are
  // selected, so planning and error grounding can reach them — but they're
  // removed from what the model sees below (planning-retrieval.ts).
  const catalog = platformFilter && platformFilter.length > 0
    ? rawCatalog.filter((t) => toolMatchesPlatforms(t.name, ['Knowledge']) || toolMatchesPlatforms(t.name, platformFilter))
    : rawCatalog;
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));

  // In Launch mode add the core Reactor/Launch read+write tools to the
  // always-on set (launch-plan.ts) so they don't have to win a shortlist slot
  // on embedding similarity, and expand the shortlist query with the parsed
  // requirements so the rest of the relevant tools still get ranked.
  // Segment runs likewise keep the profile-field lookup and the segment tools
  // always on (segment-context.ts), so the "only real fields" rule is usable.
  const alwaysOnNames = [
    ...ALWAYS_ON_TOOLS,
    ...domainAlwaysOnTools(domains.active, { publishEnabled: domains.publishEnabled === true }),
  ];
  const alwaysOn = [...new Set(alwaysOnNames)].filter((name) => catalogByName.has(name) && !isKnowledgeTool(name));
  const shortlistQuery = domains.shortlistQuery ?? userInput;
  const shortlisted = await stage('tool-shortlisting embedding call', () =>
    shortlistTools(shortlistQuery, {
      k: toolShortlistSize,
      exclude: alwaysOn,
      // Rank only tools the platform filter kept, so filtered-out tools don't
      // use up shortlist slots and leave the run with fewer usable tools.
      include: (name) => catalogByName.has(name) && !isKnowledgeTool(name),
    })
  );

  // TASK 9: the policy runs over the whole catalog, so a tool reached via
  // call_tool is filtered/dry-run-wrapped exactly like a shortlisted one.
  // Action guardrails (write cap, protected ids, result redaction) wrap the
  // same objects call_tool executes.
  const callable = applyActionGuards(
    applyToolPolicy(buildAiTools(catalog, { maxRetries: toolRetries, ragJudgmentSink, toolGate: domains.toolGate }), {
      ...policy,
      toolGate: domains.toolGate,
    })
  );
  // Built over the whole catalog so each tool's error grounding can still
  // reach the knowledge base, then hidden so call_tool can't run them either.
  for (const name of Object.keys(callable)) {
    if (isKnowledgeTool(name)) delete callable[name];
  }

  const toolsConsidered = [...new Set([...alwaysOn, ...shortlisted])].filter((name) => name in callable);
  const tools: ToolSet = Object.fromEntries(
    [...toolsConsidered, 'policy_info'].map((name) => [name, callable[name]])
  );
  // TASK 6: discovery over everything the policy allows (see tool-discovery.ts)
  Object.assign(tools, buildDiscoveryTools(catalog, callable, new Set(toolsConsidered)));

  return { tools, toolsConsidered };
}

