/**
 * Launch-tagging eval — run manually with `npm run eval:launch`.
 *
 * Grades the REAL agent loop (lib/llm/agent.ts runAgent) in Launch mode
 * (launchMode: true, so the Launch/Reactor object-model grounding is in the
 * system prompt) against SCRIPTED Reactor tools (evals/lib/scripted-tools.ts)
 * instead of the live MCP server — the same opts.tools scripted-tool path the
 * agent eval uses (evals/agent.eval.ts). Reactor tools WRITE to a real
 * property, so scripting them keeps the eval side-effect-free and repeatable
 * while the model under test is real.
 *
 * On top of the agent eval's trajectory grading (did it read the property
 * before populating, create the library, stay in scope), this suite adds the
 * Phase 4 reliability check the whole feature exists for:
 *
 *   - The rule components and data elements the run produced VALIDATE under the
 *     Phase 4 schemas (lib/llm/launch-validation.ts), and
 *   - every reference RESOLVES — each delegate names an installed extension and
 *     each %data element% reference resolves to one that exists or was created
 *     this run.
 *
 * This is checked by REPLAYING the recorded scripted-tool calls through a fresh
 * LaunchValidationGate: observe() absorbs the property state the run read and
 * the resources it created, then gate('reactor_create_library', …) runs the
 * same three checks the live handoff would be blocked by. A throw means the
 * library the devs would load does NOT validate — the fixture fails. The live
 * run creates this gate itself inside runAgent; the eval path (opts.tools)
 * doesn't, so the eval stands it up to assert the same invariant deterministically
 * (no model/network call — grading.ts style).
 *
 * Each fixture runs EVAL_TRIALS times (default 1); vitest marks it failed
 * unless every trial passed (pass^k). The suite SKIPS GRACEFULLY when no
 * provider credentials are configured, exactly like the other evals.
 *
 * EVAL_MODEL picks the model under test (default DEFAULT_MODEL);
 * EVAL_JUDGE_MODEL picks the grader (default: the strongest tier).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { runAgent } from '@/lib/llm/agent';
import { promptVersion } from '@/lib/version';
import { ModelHealthTracker } from '@/lib/llm/model-health';
import { estimateCostUsd } from '@/lib/llm/pricing';
import type { EvalTrialRecord } from '@/lib/types';
import { loadFixtures } from './lib/fixtures';
import { report, reportComparison } from './lib/report';
import { allCriteria, formatJudgeNotes, judge, JudgeError, summarizeToolActivity } from './lib/judge';
import {
  evalModelKey,
  judgeFallbackModelKey,
  judgeModelKey,
  modelSource,
  preflight,
  trialsPerFixture,
  warnIfSelfJudging,
  warnSkip,
  orchestrateMode,
  orchestrateModes,
  withOrchestration,
} from './lib/env';
import { gradeTrajectory, type TrajectoryExpectations } from './lib/grading';
import { gradeLaunchValidation, gradePublishTransition, lastResponsePerTool, type PublishExpectation } from './lib/launch-grading';
import { buildScriptedTools, type ScriptedToolDef } from './lib/scripted-tools';

type LaunchFixture = {
  id: string;
  note?: string;
  category?: string;
  request: string;
  maxSteps?: number;
  /**
   * Publish target for a publish trajectory — turns on the publish grounding
   * (build→poll→transition-to-dev/staging) and widens the always-on tools so
   * the run can reach the pipeline. Omit for a library-only fixture (the run
   * stops at a populated library, byte-identical to today).
   */
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string };
  /** Reactor tools aren't local defs and the live MCP catalog is off in the eval, so each tool carries its own description. */
  tools: ScriptedToolDef[];
  /**
   * The knowledge-search result the run's planning-stage lookup returns
   * (runAgent opts.knowledge). The model has no search tool, so knowledge
   * reaches it only this way. Omit for a run where the lookup finds nothing.
   */
  knowledge?: unknown;
  /**
   * `criteria`: optional fixture-specific rubric for the judge (base
   * correctness/safety criteria are always added).
   * `publishTransition`: for a publish trajectory, assert how a
   * reactor_transition_library call is treated when replayed through a fresh
   * validation gate seeded with the fixture's observed environment stages and
   * build status — 'allowed' (reaches published) or 'refused' (the gate throws
   * the production / unknown-stage / failed-build block). Omit for a
   * library-only fixture.
   */
  expected: TrajectoryExpectations & {
    criteria?: string[];
    publishTransition?: PublishExpectation;
  };
};

const modelKey = evalModelKey();
const judgeKey = judgeModelKey();
const judgeFallbackKey = judgeFallbackModelKey(judgeKey);
const trials = trialsPerFixture();
// Launch-mode prompt version: this suite runs with launchMode: true, so the
// recorded version matches what runAgent builds here (object-model grounding on).
const promptVersionHash = promptVersion({ launchMode: true });
const pre = await preflight('launch eval', [
  { role: 'model under test', key: modelKey, source: modelSource('model') },
  { role: 'judge', key: judgeKey, source: modelSource('judge') },
]);
if (pre.status === 'skip') warnSkip('launch eval', pre.reason);
if (pre.status === 'ready') warnIfSelfJudging(modelKey, judgeKey);
const preflightError = pre.status === 'fail' ? pre.reason : '';

// Results per orchestration mode (Requirement 16.2). EVAL_ORCHESTRATE=off (the
// default) fills only `off`; `on` only `on`; `both` fills both and the suite
// prints them side by side against the rollout bar in afterAll. The rollout
// bar is read off this suite's `both` run.
const resultsByMode: Record<'off' | 'on', EvalTrialRecord[]> = { off: [], on: [] };
const modes = orchestrateModes();
const startedAt = new Date();
let judgeUsed = false;
afterAll(async () => {
  for (const mode of modes) {
    const results = resultsByMode[mode];
    if (!results.length) continue;
    await report({
      // Its own suite: sharing 'agent' made the two evals overwrite each other's
      // metrics file and latest-run row (the baseline gate and LLM-Ops read both).
      // The orchestrated run gets its own suite key so the baseline gate tracks
      // the coordinator path separately (Requirement 16.3).
      suite: mode === 'on' ? 'launch_orchestrated' : 'launch',
      label: `Launch tagging (runAgent launchMode + scripted Reactor tools, Phase 4 validation gate${mode === 'on' ? ', orchestrated' : ''})`,
      subject: mode === 'on' ? `${modelKey} (orchestrated)` : modelKey,
      judgeModel: judgeUsed ? judgeKey : undefined,
      promptVersion: promptVersionHash,
      startedAt,
      results,
    });
  }
  // Side-by-side comparison + rollout-bar verdict when both modes ran; the
  // rollout bar in requirements.md is defined on the Launch fixtures.
  if (orchestrateMode() === 'both' && resultsByMode.off.length && resultsByMode.on.length) {
    reportComparison('Launch tagging', resultsByMode.off, resultsByMode.on);
  }
});

async function runTrial(fixture: LaunchFixture, trial: number, mode: 'off' | 'on'): Promise<EvalTrialRecord> {
  const t0 = Date.now();
  const record: EvalTrialRecord = { fixtureId: fixture.id, trial, passed: false, notes: '', category: fixture.category };
  const notes: string[] = [];

  try {
    // Fresh scripted tools per trial so response queues and call logs don't leak between trials.
    const { tools, calls } = buildScriptedTools(fixture.tools);
    // mode === 'on': force the flag and opt into the coordinator (Requirement
    // 16.2), with the same scripted Reactor tools and the same validation gate
    // replay, so any difference is the coordinator's.
    const run = await withOrchestration(mode === 'on' ? 'on' : 'off', () =>
      runAgent({
        userInput: fixture.request,
        modelKey,
        maxSteps: fixture.maxSteps ?? 16,
        tools,
        knowledge: fixture.knowledge,
        // Launch mode: object-model grounding in the system prompt, matching a real tagging run.
        launchMode: true,
        ...(mode === 'on' ? { orchestrate: true } : {}),
        // A publish fixture turns on the publish grounding (build→poll→transition
        // to dev/staging); omit it and the run stops at a populated library.
        ...(fixture.publishTarget ? { publishTarget: fixture.publishTarget } : {}),
        // Fresh tracker: one trial's provider failure must not reroute the next one to a different model.
        modelHealth: new ModelHealthTracker(),
      })
    );
    record.totalTokens = run.usage.totalTokens;
    // An orchestrated run's workers can run on WORKER_MODEL, so price it from
    // the run ledger, which charged each call at its own model's price.
    record.costUsd = run.orchestrated ? run.budgetUsage.costUsd : estimateCostUsd(run.modelKey, run.usage);
    record.steps = run.steps.length;
    record.toolCalls = calls.length;

    // (1) Trajectory, structurally — same grader the agent eval uses.
    const grade = gradeTrajectory(calls, run.finishReason, fixture.expected);
    record.structuralPassed = grade.failures.length === 0;
    record.safetyViolation = grade.safetyViolations.length > 0;
    notes.push(...grade.failures);

    // (2) Phase 4 validation gate — the produced library validates and references resolve.
    const responseByTool = lastResponsePerTool(fixture.tools);
    notes.push(...gradeLaunchValidation(calls, responseByTool));

    // (2b) Publish trajectory — assert the production block / dev-staging
    // allowance on the recorded transition, replayed through a fresh gate.
    if (fixture.expected.publishTransition) {
      notes.push(...gradePublishTransition(calls, responseByTool, fixture.expected.publishTransition, fixture.publishTarget));
    }

    // (3) Outcome, by the rubric judge, when the fixture declares criteria.
    if (fixture.expected.criteria?.length) {
      judgeUsed = true;
      try {
        const verdict = await judge(
          judgeKey,
          {
            task: fixture.request,
            criteria: allCriteria(fixture.expected.criteria),
            answer: run.finalText,
            toolActivity: summarizeToolActivity(run.steps),
          },
          judgeFallbackKey
        );
        if (!verdict.pass) notes.push(formatJudgeNotes(verdict));
      } catch (err) {
        if (!(err instanceof JudgeError)) throw err;
        if (notes.length === 0) record.errored = true;
        notes.push(`judge gave no verdict: ${err.message}`);
      }
    }
  } catch (err) {
    // A provider call threw mid-run (rate limit, outage). Preflight already
    // proved the configuration works, so this is infrastructure, not the agent.
    record.errored = true;
    notes.push(`run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  record.passed = notes.length === 0 && !record.errored;
  record.notes = notes.length ? notes.join('; ') : record.notes;
  record.durationMs = Date.now() - t0;
  return record;
}

describe.runIf(pre.status === 'fail')('Launch tagging eval preflight', () => {
  it('configured models are reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`Launch tagging eval (runAgent launchMode, k=${trials})`, () => {
  const fixtures = loadFixtures<LaunchFixture>('launch');

  it.each(fixtures)('$id', async (fixture) => {
    const failures: string[] = [];
    // Each requested mode (off, on, or both) runs the fixture's k trials.
    // Sequential, not parallel: concurrent trials against one provider turn
    // rate limits into spurious failures.
    for (const mode of modes) {
      const fixtureTrials: EvalTrialRecord[] = [];
      for (let i = 1; i <= trials; i++) fixtureTrials.push(await runTrial(fixture, i, mode));
      resultsByMode[mode].push(...fixtureTrials);
      const failed = fixtureTrials.filter((t) => !t.passed);
      if (failed.length) {
        const tag = modes.length > 1 ? `[${mode}] ` : '';
        failures.push(...failed.map((t) => `${tag}#${t.trial}${t.errored ? ' ERROR' : ''}: ${t.notes}`));
      }
    }
    expect.soft(failures.length, failures.join(' | ')).toBe(0);
  });
});
