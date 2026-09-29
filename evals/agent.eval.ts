/**
 * Agent behavior eval — run manually with `npm run eval:agent`.
 *
 * Grades the REAL agent loop (lib/llm/agent.ts runAgent: system prompt,
 * step limit, trace mapping, model resolution) with a REAL chat model, but
 * against scripted tools (evals/lib/scripted-tools.ts) instead of the live
 * MCP server — so "did it pick the narrowest tool, avoid writes it wasn't
 * asked for, read before committing, stop after repeated failures, refuse an
 * injected instruction" is graded without side effects on a real Adobe org.
 *
 * Per trial:
 *   1. Trajectory, structurally (grading.ts gradeTrajectory): which tools,
 *      how many, in what order, with what args — and which calls count as
 *      safety violations (`expected.unsafeCalls`/`unsafeArgs`).
 *   2. Outcome, by the rubric judge (lib/judge.ts), when the fixture has
 *      `expected.criteria`: numbered criteria scored 1–5 with quoted
 *      evidence, plus the base correctness/safety criteria.
 *
 * Each fixture runs EVAL_TRIALS times (default 1). Vitest marks a fixture
 * failed unless every trial passed (pass^k) — production reliability, not
 * best-of-k. The printed/stored report has pass@k, pass^k, tool-call
 * accuracy, safety violation rate, steps, p50/p95 latency and cost per
 * success.
 *
 * EVAL_MODEL picks the model under test (default DEFAULT_MODEL);
 * EVAL_JUDGE_MODEL picks the grader (default: the strongest tier).
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent } from '@/lib/llm/agent';
import { systemPrompt } from '@/lib/llm/agent-core';
import { LOCAL_TOOL_DEFINITIONS } from '@/lib/llm/local-tools';
import { getMcpToolCatalog, type McpToolDefinition } from '@/lib/llm/tool-catalog';
import { ModelHealthTracker } from '@/lib/llm/model-health';
import { estimateCostUsd } from '@/lib/llm/pricing';
import type { EvalTrialRecord } from '@/lib/types';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
import { allCriteria, formatJudgeNotes, judge, summarizeToolActivity } from './lib/judge';
import {
  evalModelKey,
  isMcpConfigured,
  judgeModelKey,
  modelSource,
  preflight,
  trialsPerFixture,
  warnIfSelfJudging,
  warnSkip,
} from './lib/env';
import { gradeTrajectory, type TrajectoryExpectations } from './lib/grading';
import { buildScriptedTools, type ScriptedToolDef } from './lib/scripted-tools';

type AgentFixture = {
  id: string;
  note?: string;
  /** e.g. "safety" for adversarial/injection cases, "scope", "recovery". */
  category?: string;
  request: string;
  maxSteps?: number;
  /** `description`/`inputSchema` may be omitted to use the real definition (local tools, or the live MCP catalog if configured). */
  tools: Array<Omit<ScriptedToolDef, 'description'> & { description?: string }>;
  /** `criteria`: fixture-specific rubric criteria for the judge (the base correctness/safety criteria are always added). */
  expected: TrajectoryExpectations & { criteria?: string[] };
};

const modelKey = evalModelKey();
const judgeKey = judgeModelKey();
const trials = trialsPerFixture();
const promptVersion = createHash('sha256').update(systemPrompt()).digest('hex').slice(0, 12);
const pre = await preflight('agent eval', [
  { role: 'model under test', key: modelKey, source: modelSource('model') },
  { role: 'judge', key: judgeKey, source: modelSource('judge') },
]);
if (pre.status === 'skip') warnSkip('agent eval', pre.reason);
if (pre.status === 'ready') warnIfSelfJudging(modelKey, judgeKey);
const preflightError = pre.status === 'fail' ? pre.reason : '';

const results: EvalTrialRecord[] = [];
const startedAt = new Date();
let judgeUsed = false;
afterAll(() =>
  report({
    suite: 'agent',
    label: 'Agent behavior (runAgent + scripted tools)',
    subject: modelKey,
    judgeModel: judgeUsed ? judgeKey : undefined,
    promptVersion,
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

async function runTrial(fixture: AgentFixture, trial: number): Promise<EvalTrialRecord> {
  const t0 = Date.now();
  const record: EvalTrialRecord = { fixtureId: fixture.id, trial, passed: false, notes: '', category: fixture.category };
  const notes: string[] = [];

  try {
    // Fresh scripted tools per trial so response queues and call logs don't leak between trials.
    const { tools, calls } = buildScriptedTools(resolveToolDefs(fixture));
    const run = await runAgent({
      userInput: fixture.request,
      modelKey,
      maxSteps: fixture.maxSteps ?? 12,
      tools,
      // Fresh tracker: one trial's provider failure must not reroute the next one to a different model.
      modelHealth: new ModelHealthTracker(),
    });
    record.totalTokens = run.usage.totalTokens;
    record.costUsd = estimateCostUsd(run.modelKey, run.usage);
    record.steps = run.steps.length;
    record.toolCalls = calls.length;

    const grade = gradeTrajectory(calls, run.finishReason, fixture.expected);
    record.structuralPassed = grade.failures.length === 0;
    record.safetyViolation = grade.safetyViolations.length > 0;
    notes.push(...grade.failures);

    if (fixture.expected.criteria?.length) {
      judgeUsed = true;
      const verdict = await judge(judgeKey, {
        task: fixture.request,
        criteria: allCriteria(fixture.expected.criteria),
        answer: run.finalText,
        toolActivity: summarizeToolActivity(run.steps),
      });
      if (!verdict.pass) notes.push(formatJudgeNotes(verdict));
    }
  } catch (err) {
    notes.push(`run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  record.passed = notes.length === 0;
  record.notes = notes.join('; ');
  record.durationMs = Date.now() - t0;
  return record;
}

describe.runIf(pre.status === 'fail')('Agent behavior eval preflight', () => {
  it('configured models are reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`Agent behavior eval (runAgent, k=${trials})`, () => {
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
    const fixtureTrials: EvalTrialRecord[] = [];
    // Sequential, not parallel: concurrent trials against one provider turn
    // rate limits into spurious failures.
    for (let i = 1; i <= trials; i++) fixtureTrials.push(await runTrial(fixture, i));
    results.push(...fixtureTrials);

    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
