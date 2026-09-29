/**
 * Agent behavior eval — run manually with `npm run eval:agent`.
 *
 * Grades the REAL agent loop (lib/llm/agent.ts runAgent: system prompt,
 * step limit, trace mapping, model resolution) with a REAL chat model, but
 * against scripted tools (evals/lib/scripted-tools.ts) instead of the live
 * MCP server — so "did it pick the narrowest tool, avoid writes it wasn't
 * asked for, read before committing, stop after repeated failures" is
 * graded without side effects on a real Adobe org.
 *
 * Each fixture's `expected` is graded structurally first (grading.ts's
 * gradeTrajectory — which tools, how many, in what order); `expected.rubric`
 * (optional) then asks the judge about the final answer's content, for the
 * rules that are about what the agent SAYS ("say plainly no tool can do
 * this", "explain what's blocking").
 *
 * EVAL_MODEL picks the model under test (defaults to DEFAULT_MODEL);
 * EVAL_JUDGE_MODEL picks the grader.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent } from '@/lib/llm/agent';
import { LOCAL_TOOL_DEFINITIONS } from '@/lib/llm/local-tools';
import { getMcpToolCatalog, type McpToolDefinition } from '@/lib/llm/tool-catalog';
import { ModelHealthTracker } from '@/lib/llm/model-health';
import { loadFixtures } from './lib/fixtures';
import { report, type EvalOutcome } from './lib/report';
import { judge } from './lib/judge';
import { evalModelKey, isMcpConfigured, isModelConfigured, judgeModelKey, warnSkip } from './lib/env';
import { gradeTrajectory, type TrajectoryExpectations } from './lib/grading';
import { buildScriptedTools, type ScriptedToolDef } from './lib/scripted-tools';

type AgentFixture = {
  id: string;
  note?: string;
  request: string;
  maxSteps?: number;
  /** `description`/`inputSchema` may be omitted to use the real definition (local tools, or the live MCP catalog if configured). */
  tools: Array<Omit<ScriptedToolDef, 'description'> & { description?: string }>;
  expected: TrajectoryExpectations & { rubric?: string };
};

const modelKey = evalModelKey();
const judgeKey = judgeModelKey();
const configured = isModelConfigured(modelKey);
if (!configured) warnSkip('agent eval', `no credentials found for model "${modelKey}" (set EVAL_MODEL or DEFAULT_MODEL).`);

const results: EvalOutcome[] = [];
const startedAt = new Date();
let judgeUsed = false;
afterAll(() =>
  report({
    suite: 'agent',
    label: 'Agent behavior (runAgent + scripted tools)',
    subject: modelKey,
    judgeModel: judgeUsed ? judgeKey : undefined,
    startedAt,
    results,
  })
);

/** Real definitions to fill in fixture tools that leave description/inputSchema out. */
const realDefs = new Map<string, McpToolDefinition>(LOCAL_TOOL_DEFINITIONS.map((d) => [d.name, d]));

function resolveToolDefs(fixture: AgentFixture): ScriptedToolDef[] {
  return fixture.tools.map((t) => {
    const real = realDefs.get(t.name);
    const description = t.description ?? real?.description;
    if (!description) {
      throw new Error(
        `tool "${t.name}" has no description in the fixture and none was found locally or in the live MCP catalog`
      );
    }
    return { ...t, description, inputSchema: t.inputSchema ?? real?.inputSchema };
  });
}

describe.skipIf(!configured)('Agent behavior eval (runAgent)', () => {
  const fixtures = loadFixtures<AgentFixture>('agent');

  beforeAll(async () => {
    // Optional: let fixtures inherit real MCP descriptions/schemas. A
    // catalog fetch failure just means every fixture must carry its own.
    if (!isMcpConfigured()) return;
    try {
      for (const def of await getMcpToolCatalog()) if (!realDefs.has(def.name)) realDefs.set(def.name, def);
    } catch (err) {
      console.warn(`[evals] Live MCP catalog unavailable (${(err as Error).message}); using fixture descriptions only.`);
    }
  });

  it.each(fixtures)('$id', async (fixture) => {
    const t0 = Date.now();
    const notes: string[] = [];
    let totalTokens: number | undefined;

    try {
      const { tools, calls } = buildScriptedTools(resolveToolDefs(fixture));
      const run = await runAgent({
        userInput: fixture.request,
        modelKey,
        maxSteps: fixture.maxSteps ?? 12,
        tools,
        // Fresh tracker: one fixture's provider failure must not reroute the next fixture to a different model.
        modelHealth: new ModelHealthTracker(),
      });
      totalTokens = run.usage.totalTokens;

      notes.push(...gradeTrajectory(calls, run.finishReason, fixture.expected));

      if (fixture.expected.rubric) {
        judgeUsed = true;
        const verdict = await judge(judgeKey, fixture.request, fixture.expected.rubric, run.finalText);
        if (!verdict.pass) notes.push(`judge: ${verdict.reasoning}`);
      }
    } catch (err) {
      notes.push(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const passed = notes.length === 0;
    results.push({ fixtureId: fixture.id, passed, notes: notes.join('; '), durationMs: Date.now() - t0, totalTokens });
    expect.soft(passed, notes.join('; ')).toBe(true);
  });
});
