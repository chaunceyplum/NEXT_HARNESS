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
import {
  LaunchValidationGate,
  isLaunchHandoffTool,
  LAUNCH_HANDOFF_TOOLS,
} from '@/lib/llm/launch-validation';
import type { EvalTrialRecord } from '@/lib/types';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
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
} from './lib/env';
import { gradeTrajectory, type RecordedCall, type TrajectoryExpectations } from './lib/grading';
import { buildScriptedTools, type ScriptedToolDef } from './lib/scripted-tools';

type LaunchFixture = {
  id: string;
  note?: string;
  category?: string;
  request: string;
  maxSteps?: number;
  /** Reactor tools aren't local defs and the live MCP catalog is off in the eval, so each tool carries its own description. */
  tools: ScriptedToolDef[];
  /** `criteria`: optional fixture-specific rubric for the judge (base correctness/safety criteria are always added). */
  expected: TrajectoryExpectations & { criteria?: string[] };
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

const results: EvalTrialRecord[] = [];
const startedAt = new Date();
let judgeUsed = false;
afterAll(() =>
  report({
    // Reuse the 'agent' suite: this IS the agent loop graded against scripted
    // tools, just in Launch mode with the added validation-gate assertion.
    suite: 'agent',
    label: 'Launch tagging (runAgent launchMode + scripted Reactor tools, Phase 4 validation gate)',
    subject: modelKey,
    judgeModel: judgeUsed ? judgeKey : undefined,
    promptVersion: promptVersionHash,
    startedAt,
    results,
  })
);

/**
 * Phase 4 reliability check: replay the run's scripted-tool calls through a
 * fresh validation gate so the library handoff is validated the way a live
 * run's gate would validate it (launch-validation.ts). Returns the failures
 * found — empty means the produced library validates and every reference
 * resolves. Deterministic, no model/network call.
 *
 * The scripted path records each call's input but not its result, so observe()
 * is fed the input as both args and result: LaunchPropertyState reads
 * extension/data-element names out of either shape, and the fixture's scripted
 * responses mirror those inputs, so the state the gate sees matches what the
 * live run would have observed from the server echo.
 */
function gradeLaunchValidation(calls: RecordedCall[], responseByTool: Map<string, unknown>): string[] {
  const failures: string[] = [];
  const gate = new LaunchValidationGate();

  for (const call of calls) {
    // Feed the gate both the args and the scripted result for this tool, so it
    // absorbs the property state (installed extensions, known data elements)
    // the run read as well as the resources it created.
    gate.observe(call.toolName, call.input, responseByTool.get(call.toolName) ?? call.input);
  }

  const handoff = calls.find((c) => isLaunchHandoffTool(c.toolName));
  if (!handoff) {
    failures.push(
      `no library handoff call (${[...LAUNCH_HANDOFF_TOOLS].join(' / ')}) — the run never produced a library to validate`
    );
    return failures;
  }

  try {
    // Throws when the produced components don't validate or a reference doesn't
    // resolve — the SAME block a live run would hit before the MCP write.
    gate.gate(handoff.toolName, handoff.input);
  } catch (err) {
    failures.push(`library handoff failed Phase 4 validation: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

async function runTrial(fixture: LaunchFixture, trial: number): Promise<EvalTrialRecord> {
  const t0 = Date.now();
  const record: EvalTrialRecord = { fixtureId: fixture.id, trial, passed: false, notes: '', category: fixture.category };
  const notes: string[] = [];

  try {
    // Fresh scripted tools per trial so response queues and call logs don't leak between trials.
    const { tools, calls } = buildScriptedTools(fixture.tools);
    const run = await runAgent({
      userInput: fixture.request,
      modelKey,
      maxSteps: fixture.maxSteps ?? 16,
      tools,
      // Launch mode: object-model grounding in the system prompt, matching a real tagging run.
      launchMode: true,
      // Fresh tracker: one trial's provider failure must not reroute the next one to a different model.
      modelHealth: new ModelHealthTracker(),
    });
    record.totalTokens = run.usage.totalTokens;
    record.costUsd = estimateCostUsd(run.modelKey, run.usage);
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

/**
 * The result a tool returns on its LAST scripted response, keyed by tool name
 * — what the gate's observe() uses to read property state the run grounded on
 * (installed extensions, existing data elements). Reads scripted
 * `{ result }` responses; `{ error }` responses contribute nothing.
 */
function lastResponsePerTool(defs: ScriptedToolDef[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const def of defs) {
    const responses = def.responses ?? [];
    for (let i = responses.length - 1; i >= 0; i--) {
      const r = responses[i];
      if ('result' in r) {
        map.set(def.name, r.result);
        break;
      }
    }
  }
  return map;
}

describe.runIf(pre.status === 'fail')('Launch tagging eval preflight', () => {
  it('configured models are reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`Launch tagging eval (runAgent launchMode, k=${trials})`, () => {
  const fixtures = loadFixtures<LaunchFixture>('launch');

  it.each(fixtures)('$id', async (fixture) => {
    const fixtureTrials: EvalTrialRecord[] = [];
    // Sequential, not parallel: concurrent trials against one provider turn
    // rate limits into spurious failures.
    for (let i = 1; i <= trials; i++) fixtureTrials.push(await runTrial(fixture, i));
    results.push(...fixtureTrials);

    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}${t.errored ? ' ERROR' : ''}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
