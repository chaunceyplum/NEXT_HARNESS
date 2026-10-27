# Worker agents that run one plan step via executeLoop (Task 5)

This change introduces the per-step worker: a bounded agent that carries out a single plan step by reusing the same `executeLoop` single-agent runs use, rather than a second loop implementation. The approach keeps all the hard-won loop behaviour (tracing, budget, same-tier fallback, write-detection, approval gating) in one place and bolts on three worker-specific levers through `LoopContext`: a forced terminal tool (`report_result`), a parent ledger so every worker step charges the run-wide budget, and a child abort controller linked to the run. The worker file adds the `report_result` tool with character caps, tool narrowing by platform group, a transcript-free brief builder, and `runWorker` itself. Task 5 is one of ten PRs; the coordinator that drives these workers lands in Task 6, so nothing calls `runWorker` in production yet.

Watch for: the budget wrap-up path sends a free-choice worker a contradictory signal — `budgetFinalNote` says "Do not call any more tools" while `toolChoice` simultaneously forces `report_result` (confirmed, non-blocking, behaviour is still correct). Everything else — tool narrowing, truncation, fallback-before-write vs fail-after-write, abort, and the missing-result failure — is implemented and directly tested.

**Verdict**: APPROVED

## High-level view

The worker is a thin wrapper over `executeLoop`. Two new optional `LoopContext` fields carry the worker semantics: `forceFinalTool` turns the last-allowed step from "force text, toolChoice none" into "force this tool", and `budgetParent` points the per-attempt tracker at the run ledger so each step charges both the worker's child slice and the run total. Both default unset, so the single-agent path rebuilds its tracker with a `Date.now`/`undefined`-parent tail that is behaviourally identical to before — this is the critical no-regression guarantee and it holds.

Budget slicing moved from `RunLedger.child()` (one tracker) to `RunLedger.childLimits()` (just the limits). This matters because `executeLoop` rebuilds its tracker on every fallback attempt; handing it limits plus the ledger lets each rebuilt attempt keep charging the same ledger, whereas a single `child()` tracker would have been discarded on restart. The slice is `share` of what the run has *left* at worker start, so concurrent workers can't collectively overspend.

Tool narrowing gives a worker its step tool, the platform-group siblings the run already allows (scoped to real catalog tools so synthetic locals aren't pulled in as accidental group members), plus `find_tools`/`call_tool`/`report_result`, and never `remember_fact`/`update_plan`/`revise_plan`. The brief carries the goal, the step, dependency `WorkerResult`s and planning knowledge — no other worker's transcript.

Lifecycle and failure modes rest on behaviour that already exists in `executeLoop`: same-tier fallback before any write, refusal to restart an attempt that already wrote (it rethrows "already executed write/destructive"), and abort propagation. `runWorker` maps those outcomes to a `WorkerRecord`: no `report_result` → failed "worker ended without a result"; an abort → `cancelled`; any other throw → `failed` with the run-level usage still reported so a failed worker's spend is accounted for.

<details>
<summary>Issues (2)</summary>

1. **Budget wrap-up sends a contradictory instruction** — on a budget-exceeded last step the worker gets `budgetFinalNote` ("Do not call any more tools") while `toolChoice` forces `report_result`; behaviour is correct (ends on a structured result) but the note text contradicts the forced choice. Consider a worker-specific wrap-up note when `forceFinalTool` is set. Non-blocking.
2. **Types temporarily home in worker.ts** — `WorkerStatus`/`WorkerResult`/`WorkerRecord` live in `worker.ts` with a comment that Task 8.1 re-homes them to `lib/types.ts`. Tracked by the spec, flagged so the move isn't forgotten. Non-blocking.

</details>

<details>
<summary>Details</summary>

### forceFinalTool: ending on a tool instead of on text

`executeLoop`'s `prepareStep` previously forced `toolChoice: 'none'` on the last allowed step, ending the loop with free text. The change makes that terminal choice conditional: when `ctx.forceFinalTool` is set, the last step forces `{ type: 'tool', toolName }`; when unset it keeps forcing `'none'`. History-bound models (which must not have their tool choice changed mid-run) instead get an appended `Call <tool> now.` instruction in place of the generic `FINAL_STEP_NOTE`. The single-agent path leaves `forceFinalTool` undefined, so both branches collapse to the prior behaviour — verified by reading the else-if and the `lastStepToolChoice` ternary (confirmed).

One behavioural wrinkle is worth a reviewer's attention (confirmed). When the run budget is exhausted, `exceeded` is truthy and `budgetFinalNote` is pushed — text that tells the model "Do not call any more tools." But the `forceFinalTool` branch below is `else if`, so the note is the budget one, while `lastStepToolChoice` still resolves to the forced `report_result`. A free-choice worker is therefore told not to call tools and simultaneously forced to call one. The in-code comment frames this as deliberate ("stops cleanly rather than making one more tool call it can't pay for"), and the outcome is the desired one — the loop ends on a structured `report_result` rather than free text the coordinator can't parse. The cost is a mixed signal to the model on exactly one step. A worker-specific wrap-up note ("You are out of budget; call `report_result` now with what you have") would remove the contradiction. Not blocking: the forced `toolChoice` wins mechanically regardless of the note.

### Budget: childLimits over child, and parent charging

The refactor from `RunLedger.child()` returning a tracker to `childLimits()` returning just `RunBudgetLimits` is the right shape for the fallback story. `executeLoop` rebuilds its `RunBudgetTracker` on the first call and again inside `callModel` on every fallback attempt, now passing `ctx.budgetParent` as the fifth constructor argument. A single `child()` tracker would have been thrown away on the first restart and the ledger would have stopped being charged; handing down the limits plus the ledger means every rebuilt attempt charges the same ledger through `recordStep` → `parent?.charge`. The constructor signature `(limits, modelKey, startedAt, now?, parent?)` matches the new five-argument call, and the single-agent call sites pass `Date.now, ctx.budgetParent` where `budgetParent` is undefined, leaving `parent` unset (confirmed by reading both the constructor and the two call sites).

The slice itself is `scaleRemaining(limit, used, share)` = `(limit − used) * share`, floored at zero, computed at worker start. Because it reads the ledger's *current* `tokens`/`costUsd`, each worker's cap reflects what earlier workers already spent, so no set of workers can run the run past its limits. `exceeded()` on the child reports the ledger's `exhausted()` reason even when the child's own slice has room, which is what lets a run-level limit stop a worker mid-step.

### Tool narrowing by platform group

`workerTools(all, step, catalog)` keeps the step's own tool, walks `all` for same-`PLATFORM_GROUPS`-group tools that are *both* run-allowed and present in the catalog, and always adds `find_tools`/`call_tool` (the discovery pair, so a worker with a null or mis-named step tool can still find what it needs). The catalog scoping is the subtle correctness point: `platformsOf` is derived from tool names, and without the `catalogNames` gate the synthetic local tools (`find_tools`, `call_tool`, `report_result`, `policy_info`) could be pulled in as accidental group siblings. Gating group expansion to real catalog tools keeps the local tools under the explicit rules only. `EXCLUDED_WORKER_TOOLS` structurally removes `remember_fact`/`update_plan`/`revise_plan` whatever the step.

### runWorker: lifecycle and failure mapping

The truncation caps (`summary` to 1,000, `notes` to 500) and id coercion are enforced in `report_result`'s `execute`, not just asked of the model in the schema, and the sink is last-write-wins. The brief carries no other worker's step trace or message history. Both are directly unit-tested.

`runWorker` wires the child `AbortController` to the run signal — already-aborted runs start the child aborted, otherwise a one-shot listener forwards the abort and `finally` removes it. Its value over the raw loop is the failure mapping, each branch grounded in `executeLoop` behaviour that exists unchanged in the base branch (confirmed by reading `agent.ts` around the `attemptHadSideEffects` guard): a loop that returns without a captured `report_result` → failed step "worker ended without a result"; a captured result's own `status` decides done vs failed; a throw → `cancelled` when the child signal is aborted, else `failed`, and in the catch it reports `shared.ledger.usage()` so a failed worker's spend is still accounted for. The per-worker fallback (restart on a same-tier model before any write, refuse to restart after a write and rethrow) is the loop's existing guard; `runWorker` lets the rethrow fall into its catch.

### Test coverage

`worker.test.ts` runs `runWorker` end-to-end against a scripted `MockLanguageModelV4` with a two-model balanced tier so `pickFallback` has a same-tier target. The twelve cases cover: tool narrowing (siblings kept, off-group dropped, exclusions, null-step-tool discovery), truncation and id coercion, the brief contents, the happy path with the forced `report_result` observed in the recorded `toolChoice`, the `report_result status:failed` path, the missing-result failure, restart-before-write firing `onRestart` and landing on `test:b`, fail-after-write asserting `onRestart` was *not* called and the write ran exactly once, and the already-aborted → `cancelled` case. The scripted model errors through the stream (not a thrown `doStream`, which the SDK would silently retry), which is the correct way to reach the loop's fallback catch.

Not tested: the budget-exhaustion wrap-up path through a worker (the contradictory-note interaction above is reasoned, not exercised); a `report_result` called twice to confirm last-write-wins in an actual loop run (the sink contract is unit-tested but not through `runWorker`); approval-gated worker tool calls (deferred — `toolApproval` is threaded through but wiring lands in Task 7.2). None of these block Task 5, since the coordinator and gating are later tasks, but the budget-wrap-up-through-a-worker case is worth adding when Task 6 lands.

### Scope

The diff is confined to Task 5: the two `LoopContext` additions and their use in `executeLoop`, the `RunLedger.child`/`childLimits` split, and the new `worker.ts`/`worker.test.ts`. No unrelated files changed, no existing test, fixture or baseline was touched (consistent with the CI note that 523 = 511 + 12). The temporary home of `WorkerStatus`/`WorkerResult`/`WorkerRecord` in `worker.ts` is called out in-code as a Task 8.1 move.

### CI evidence

`.agents/tasks/ci-task5.md` records all four gates green in the worktree: `tsc --noEmit` clean, `lint` 0/0, `vitest run` 523 passed across 47 files, and `next build` compiled. The 523 count reconciles against Task 4's 511 plus the 12 new worker cases. Per instructions the suites were not re-run; the diff was read against this evidence, with narrow spot-checks confirming the tracker constructor arity, the `classifyTool` "create"→write classification that makes the fail-after-write test valid, and the `exceeded`/`forceFinalTool` branch interaction.

</details>

<details>
<summary>File map</summary>

- `lib/llm/agent-core.ts` — add optional `forceFinalTool` and `budgetParent` to `LoopContext`; import `RunLedger` type.
- `lib/llm/agent.ts` — `executeLoop` passes `budgetParent` to both tracker builds; last-step `toolChoice` forces `forceFinalTool` when set, else `'none'`; history-bound last-step note becomes `Call <tool> now.` when forced.
- `lib/llm/run-budget.ts` — split `RunLedger.child()` into `childLimits()` (limits only) + thin `child()`.
- `lib/llm/worker.ts` — new: `reportResultTool` with caps, `workerTools` narrowing, `buildWorkerBrief`, `runWorker`, and the worker result/record types.
- `lib/llm/worker.test.ts` — new: 12 scripted-tool cases.
- `.kiro/specs/orchestrator-workers/tasks.md` — Task 5 subtasks checked off.
- `.agents/tasks/ci-task5.md` — CI evidence.

Full diff: `git show HEAD` on `feat/orchestrator-workers`.

</details>
