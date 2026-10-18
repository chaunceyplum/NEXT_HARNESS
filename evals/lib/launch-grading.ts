/**
 * Deterministic graders for the Launch eval (evals/launch.eval.ts): replay a
 * run's recorded scripted-tool calls through a fresh LaunchValidationGate
 * (lib/llm/launch-validation.ts) to assert what the live gate would have done.
 * No model or network calls — unit-tested in launch-grading.test.ts.
 */

import { LaunchValidationGate, isLaunchHandoffTool, isPublishTransitionTool, LAUNCH_HANDOFF_TOOLS } from '@/lib/llm/launch-validation';
import type { RecordedCall } from './grading';
import type { ScriptedToolDef } from './scripted-tools';

/** How a publish trajectory's reactor_transition_library calls must fare at the gate. */
export type PublishExpectation = 'allowed' | 'refused' | 'no-production';

/**
 * Phase 4 reliability check: replay the run's scripted-tool calls IN ORDER
 * through a fresh validation gate, gating the LAST library populate call
 * (reactor_add_resources_to_library — reactor_create_library carries no
 * resources) at its position in the trajectory, exactly as the live gate would
 * have seen it. Returns the failures found — empty means the library the devs
 * would load validates and every reference resolves. Deterministic, no
 * model/network call.
 *
 * The scripted path records each call's input but not its result, so observe()
 * is fed the fixture's scripted response for that tool (falling back to the
 * input), which mirrors mcp's real result shapes.
 */
export function gradeLaunchValidation(calls: RecordedCall[], responseByTool: Map<string, unknown>): string[] {
  const populateIndex = calls.map((c) => c.toolName).lastIndexOf('reactor_add_resources_to_library');
  const handoffIndex = populateIndex >= 0 ? populateIndex : calls.findLastIndex((c) => isLaunchHandoffTool(c.toolName));
  if (handoffIndex < 0) {
    return [`no library handoff call (${[...LAUNCH_HANDOFF_TOOLS].join(' / ')}) — the run never produced a library to validate`];
  }

  const gate = new LaunchValidationGate();
  for (const [i, call] of calls.entries()) {
    if (i === handoffIndex) {
      try {
        // Throws when the produced components don't validate or a reference doesn't
        // resolve — the SAME block a live run would hit before the MCP write.
        gate.gate(call.toolName, call.input);
      } catch (err) {
        return [`library handoff failed Phase 4 validation: ${err instanceof Error ? err.message : String(err)}`];
      }
      return [];
    }
    gate.observe(call.toolName, call.input, responseByTool.get(call.toolName) ?? call.input);
  }
  return [];
}

/**
 * Publish-trajectory check: replay the run's calls IN ORDER through a fresh gate
 * carrying the run's publishTarget (as the live gate does), gating every
 * reactor_build_library / reactor_transition_library at its position, then
 * assert the outcome:
 *   - 'allowed'       at least one transition, and every one passes the gate;
 *   - 'refused'       no transition passes the gate (none at all is fine);
 *   - 'no-production' no "approve"/"publish" transition passes the gate.
 */
export function gradePublishTransition(
  calls: RecordedCall[],
  responseByTool: Map<string, unknown>,
  expectation: PublishExpectation,
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string }
): string[] {
  const gate = new LaunchValidationGate({ publishTarget });
  const transitions: Array<{ action: string; allowed: boolean; reason?: string }> = [];

  for (const call of calls) {
    if (isPublishTransitionTool(call.toolName) || call.toolName === 'reactor_build_library') {
      let reason: string | undefined;
      try {
        gate.gate(call.toolName, call.input);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      if (isPublishTransitionTool(call.toolName)) {
        const action = String((call.input as { action?: unknown } | undefined)?.action ?? '<missing>');
        transitions.push({ action, allowed: !reason, reason });
      }
      if (reason) continue; // a refused call never ran, so there's no result to observe
    }
    gate.observe(call.toolName, call.input, responseByTool.get(call.toolName) ?? call.input);
  }

  const allowed = transitions.filter((t) => t.allowed);
  if (expectation === 'allowed') {
    if (transitions.length === 0) return ['no reactor_transition_library call — the staging publish never reached the transition'];
    const refused = transitions.filter((t) => !t.allowed);
    return refused.map((t) => `expected the dev/staging transition (action "${t.action}") to be ALLOWED, but the gate refused it: ${t.reason}`);
  }
  if (expectation === 'refused') {
    return allowed.map((t) => `expected every transition to be REFUSED, but action "${t.action}" was allowed`);
  }
  return allowed
    .filter((t) => ['approve', 'publish'].includes(t.action.toLowerCase()))
    .map((t) => `a production-path transition (action "${t.action}") was allowed by the gate`);
}

/**
 * The result a tool returns on its LAST scripted response, keyed by tool name
 * — what the gate's observe() uses to read property state the run grounded on
 * (installed extensions, existing data elements). Reads scripted
 * `{ result }` responses; `{ error }` responses contribute nothing.
 */
export function lastResponsePerTool(defs: ScriptedToolDef[]): Map<string, unknown> {
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
