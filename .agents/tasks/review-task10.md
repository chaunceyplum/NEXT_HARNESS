# Evals and rollout check for orchestrator-workers (Task 10)

Task 10 wires orchestration into the two comparison eval suites. Scripted tools now answer by name + input so concurrent workers get stable results; `EVAL_ORCHESTRATE=off|on|both` runs each fixture single-agent, orchestrated, or both with a side-by-side table and a rollout-bar verdict; two new agent fixtures exercise independent steps and a forced worker failure; and `agent_orchestrated` / `launch_orchestrated` baseline keys track the coordinator path separately. The code is clean and the CI evidence shows tsc, lint, 562 tests, and build all green, plus both suites run end to end with the baseline gate passing.

Watch for: **(confirmed, blocking)** Task 10.5 requires the run results to be recorded against the rollout bar *in the introduction of `requirements.md`*. The commit does not touch `requirements.md`; the rollout-bar results live only in `ci-task10.md`. The named destination is unchanged, so the task is marked `[x]` against an acceptance criterion it does not meet.

**Verdict**: NEEDS_CHANGES

## High-level view

The scripted-tools change is the load-bearing piece: a response may now carry a `when` matcher that pins it to a call's input (name + input, order-independent), while responses without `when` keep per-tool queue order. That back-compat fallback is what keeps every existing fixture behaving exactly as before, and it is unit-tested directly.

The suite plumbing threads a `mode` ('off' | 'on') through each trial. `withOrchestration` flips `ORCHESTRATION` in the environment for the trial's duration and restores it in a `finally`, and `mode === 'on'` additionally passes `orchestrate: true`. `both` runs each fixture in both modes, reports each under its own suite key (`agent` / `agent_orchestrated`, `launch` / `launch_orchestrated`), then prints the comparison. The baseline keys and labels are extended to match, and the regression gate already iterates all keys, so the coordinator path is gated the same way as single-agent.

The rollout-bar logic is isolated in `compareToRolloutBar` and fails conservatively — a missing wall-clock or cost figure fails that part rather than passing it — which is the right default and is covered by tests. The two new fixtures grade structurally (no judge), so the mode comparison does not hinge on model wording; the forced-failure fixture bounds the failing read to the worker step budget.

The gap is in 10.5's recording requirement. The harness side is complete and the results were produced, but they were written to `ci-task10.md` instead of the introduction of `requirements.md`, which 10.5 names explicitly. On the measured run orchestration does not clear the bar (0%→0% pass parity, −6% wall-clock vs the −30% needed, cost n/a), so it correctly stays off by default — but that verdict is not reflected where the task says to put it.

<details>
<summary>Issues (1)</summary>

1. **Rollout results not recorded in requirements.md** — 10.5 requires the both-mode results to be recorded against the rollout bar in the introduction of `requirements.md`; they exist only in `ci-task10.md` and `requirements.md` is untouched by the commit. Add the measured off/on comparison and the "stays off by default" verdict to the rollout-bar section of the requirements intro, then re-mark 10.5.

</details>

<details>
<summary>Details</summary>

### Order-independent scripted answers (10.1)

`ScriptedResponse` gains an optional `when: ResponseMatch`. `matchesInput` requires every listed field to appear (case-insensitive substring of the JSON-serialized value) in the call's input for that key — the same shape as the grader's `argsContain`, so fixtures express a match the way they express an assertion. Selection prefers a matcher over the queue, and matched responses are never consumed so they can answer repeatedly; unmatched responses still advance a per-tool counter and repeat the last. This is the correct fix for interleaved concurrent workers: a single global queue counter would hand a call the response meant for another. (confirmed)

The back-compat claim holds: `unmatched = responses.filter((r) => !r.when)` and the counter walks only that list, so fixtures with no `when` are byte-for-byte unchanged in behavior. Covered by `scripted-tools.test.ts`, including the mixed queue + matcher case and the error-response case. (confirmed)

### EVAL_ORCHESTRATE and side-by-side reporting (10.2)

`orchestrateMode`/`orchestrateModes` read the env var (default `off`, unknown → `off`, case-insensitive), and `withOrchestration` forces `ORCHESTRATION` for the callback and restores the prior value — including restoring-to-unset — in a `finally`. Both `agent.eval.ts` and `launch.eval.ts` collect `resultsByMode`, report each mode under its own suite key, and call `reportComparison` only when `both` ran and both arrays are non-empty. (confirmed)

`reportComparison` prints pass rate, pass^k, median/p95 wall-clock, cost, tokens/success and safety violations in two columns, then the rollout-bar verdict with per-criterion marks. `compareToRolloutBar` treats a missing figure as a fail for that criterion (`frac` returns undefined on a null/zero base, and `wallClockMet`/`costMet` require a non-null delta), which is the conservative choice and is asserted in `orchestrate-eval.test.ts`. (confirmed)

### Independent-step and forced-failure fixtures (10.3)

`parallel-independent-reads` lists two unrelated reads (schemas, datasets) with no data dependency and asserts both are called, no create/delete runs, and `adobe_delete_dataset` is an unsafe call — structural grading, no judge. `parallel-one-branch-fails` makes `adobe_list_destinations` return a persistent 500 on every call while the audiences read succeeds, capping the failing read at `WORKER_MAX_STEPS=6` and bounding retries. Both are graded so the comparison does not depend on model wording. (confirmed)

### Baseline keys for the coordinator path (10.4)

`agent_orchestrated` and `launch_orchestrated` are added to `baseline.json` (safety ceiling 0, success floors `null` per the documented policy), to the `EvalSuite` union, and to `EVAL_SUITE_LABELS`. The orchestrated `report()` calls write under these suite names, and `check-eval-baseline.mjs` already iterates every key, so the CI evidence showing all four suites gated at 0.0% safety is consistent with the code. (confirmed)

### Rollout recording destination (10.5)

This is the blocking gap. The harness produces the comparison and the CI evidence records it: Launch 0%→0% pass parity, median wall-clock −6% (needs ≤ −30%), cost n/a, so orchestration does not clear the bar and correctly stays off by default. But 10.5's acceptance text is specific — results recorded "in the introduction of `requirements.md`" — and the requirements intro still contains only the *definition* of the rollout bar (lines 29–31), with no recorded run and no verdict. `git show --stat` confirms the commit does not modify `requirements.md`. The evidence exists in the wrong file relative to what the task names. (confirmed)

The Launch pass rate being 0% in both modes makes the parity vacuous (the model stopped to ask for IDs and made almost no tool calls), which the CI note acknowledges. That is a model-behavior observation, not a code defect, and does not by itself block — the rollout machinery works and fails conservatively. The block is the recording location, not the numbers. (confirmed)

</details>

<details>
<summary>File map</summary>

- `evals/lib/scripted-tools.ts` — `when` matcher + `matchesInput`; prefer matcher, fall back to per-tool queue
- `evals/lib/scripted-tools.test.ts` — new: order-independence, mixed queue+matcher, error, back-compat
- `evals/lib/env.ts` — `orchestrateMode` / `orchestrateModes` / `withOrchestration`
- `evals/lib/report.ts` — `ROLLOUT_BAR`, `compareToRolloutBar`, `reportComparison`
- `evals/lib/orchestrate-eval.test.ts` — new: env readers, `withOrchestration` restore, rollout-bar verdict
- `evals/agent.eval.ts` / `evals/launch.eval.ts` — per-mode results, own suite keys, comparison in afterAll
- `evals/fixtures/agent/parallel-independent-reads.json` / `parallel-one-branch-fails.json` — new fixtures
- `evals/baseline.json` — `agent_orchestrated` / `launch_orchestrated` keys
- `lib/types.ts` / `lib/eval-labels.ts` — `EvalSuite` union + labels for the two keys
- `.env.local.example` / `ENVIRONMENT_VARIABLES.md` — document `EVAL_ORCHESTRATE`
- `.kiro/specs/orchestrator-workers/tasks.md` — Task 10 marked done
- `.agents/tasks/ci-task10.md` — CI + eval evidence (holds the rollout results that 10.5 wants in requirements.md)

Full diff: `git show 36dc914`
</details>
