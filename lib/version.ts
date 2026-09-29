/**
 * Version fingerprints for a run, so a stored score / trace can be tied to the
 * exact prompt, tool set and build it came from (item #8 in REMAINING-WORK,
 * agentic design patterns §5.6 / §6.6).
 *
 * These are short, stable hashes — not secrets and not collision-proof — meant
 * only to answer "did the prompt / tools / code change between these two runs?"
 * The eval suite (evals/agent.eval.ts) and runAgent (lib/llm/agent.ts) both
 * compute promptVersion the same way through shortHash(), so an eval score and
 * a production run are directly comparable.
 */

import { createHash } from 'node:crypto';
import { systemPrompt } from './llm/agent-core';

/** First 12 hex chars of the sha256 of `input`. The project-wide version-hash convention. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Hash of the exact system prompt text.
 *
 * `toolDiscovery` must match how the prompt is actually built for the run: live
 * runs include the find_tools/call_tool rule (toolDiscovery: true), the eval
 * path does not. Default false keeps the eval's historical value stable.
 */
export function promptVersion(opts: { toolDiscovery?: boolean } = {}): string {
  return shortHash(systemPrompt({ toolDiscovery: opts.toolDiscovery ?? false }));
}

/**
 * Hash of the tool set the model was given — sorted `name\u0000description`
 * lines, so it's stable regardless of tool order and changes when a tool is
 * added, removed, or its description is edited. Pass whatever the model saw
 * (the shortlist + always-on + discovery tools).
 */
export function toolsetVersion(tools: Array<{ name: string; description?: string }>): string {
  const lines = tools
    .map((t) => `${t.name}\u0000${t.description ?? ''}`)
    .sort()
    .join('\n');
  return shortHash(lines);
}

/**
 * The running build. Prefers an explicit deploy identifier from the
 * environment (a CI-injected commit SHA or a release version) and falls back
 * to 'dev' locally. Read once per call so a redeploy that changes the env is
 * reflected without a restart in dev.
 */
export function appVersion(): string {
  const fromEnv =
    process.env.GIT_SHA?.trim() ||
    process.env.APP_VERSION?.trim() ||
    process.env.npm_package_version?.trim();
  return fromEnv || 'dev';
}
