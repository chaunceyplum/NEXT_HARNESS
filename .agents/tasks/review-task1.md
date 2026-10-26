# Split `runAgent` into `prepareRun` + `executeLoop` (Task 1)

The ~500-line `runAgent` is cut into a setup half (`prepareRun`) and an execution half (`executeLoop`), with the data contracts the two halves pass around parked as types in `lib/llm/agent-core.ts`. `runAgent` keeps its signature and return shape and is now `prepareRun` then `executeLoop`, reassembling the same `AgentRunResult`. The point is to let Phase 2 workers drive the model loop through an explicit `LoopContext` instead of the closures the single function relied on, without changing single-agent behaviour. Only three files change: `agent-core.ts`, `agent.ts`, and a CI evidence doc.

Watch for: nothing blocking. The checkpoint rule (no test, eval fixture, or `baseline.json` edits) holds — confirmed by name-status, only the two source files and `.agents/tasks/ci-task1.md` changed. The split is behaviour-preserving as far as the diff shows (confirmed by tracing every moved read and both early-return sites). `TokenUsage` now exists both in `lib/types.ts` and `lib/llm/agent-core.ts`, but that is a move of the existing `agent.ts` copy, not a new duplication (possible tidy-up later, not an issue here).

**Verdict**: APPROVED

## High-level view

The seam lands exactly where the design put it: `prepareRun` owns routing, launch-mode resolution, the validation gate, brief parse, tool selection, memory, planning retrieval, planning and plan approval; `executeLoop` owns the tracer, budget, `callModel`, the fallback loop and result assembly. The two early returns the old function had (unclear route, denied plan) are now wrapped as `EarlyResult` and returned verbatim by `runAgent` ahead of any loop — the assembled objects are field-for-field identical to the originals.

Every value the loop used to read from an enclosing closure is now a `LoopContext` field, read at the top of `executeLoop` or via `ctx.`. The one new output is `LoopResult.hadSideEffects`, surfacing the previously-internal `attemptHadSideEffects` flag; `runAgent` ignores it, so the single-agent result is unchanged. The `launchGate` the design sketch listed on `LoopContext` is deliberately absent — it stays captured inside the `toolApproval` closure built in `prepareRun`, which is the behaviour-preserving choice and keeps the gate out of the loop's contract until a Phase where workers need to share it.

`agent-core.ts` stays types-only: its new imports are all `import type`, no live MCP client, matching subtask 1.1. `TokenUsage`/`ToolOutcome` moved there from `agent.ts` and are re-exported from `agent.ts`, so `build-run.ts`, `pricing.ts`, `agent.test.ts` and the rest compile unchanged.

The CI evidence (tsc, lint, 481/481 unit tests, build all green; evals fail identically on the stashed baseline and the refactor) is recorded in `.agents/tasks/ci-task1.md` and the commit message, and was read rather than re-run.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. Two informational observations (dropped `launchGate`/`tracerParent`/`forceFinalTool` from the `LoopContext` sketch; `TokenUsage` now defined in both `types.ts` and `agent-core.ts`) are intentional and in scope for later phases — see the details below.

</details>

<details>
<summary>Details</summary>

### The seam matches subtasks 1.1–1.4

`prepareRun(opts): Promise<PreparedRun | EarlyResult>` covers everything the tasks list under 1.3: routing (`routeRequest`, `opts.onRoute`), launch/publish resolution, the `LaunchValidationGate`, the Launch brief parse, tool selection (`selectLiveTools` + memory fetch + planning retrieval in one `Promise.all`), the memory preamble, planning retrieval injection, planning (`seedLaunchPlan`/`makePlan`), plan approval, the few-shot preamble, and the `toolApproval` closure. `executeLoop(ctx): Promise<LoopResult>` covers 1.2: tracer setup, `RunBudgetTracker`, `callModel`, the same-tier fallback loop, `finishTrace`, and result assembly. `runAgent` (1.4) is the two-call composition.

The `agent-core.ts` contracts (1.1) are `LoopContext`, `LoopResult`, `PreparedRun`, `EarlyResult`, plus the supporting `ToolApprovalFn`, `EarlyRunResult`, and the moved `TokenUsage`/`ToolOutcome`. All nine imports the module gained are `import type`; it imports no live MCP client. The subtask's "types only" constraint is met.

The only divergence from the design's `LoopContext` sketch is that the implementation uses `startModelKey` instead of `modelKey`, `budgetLimits` instead of a `budget` handle, and omits `launchGate`, `tracerParent` and `forceFinalTool`. The design text itself tags `budget: BudgetHandle`, `tracerParent` and `forceFinalTool` as Phase 2/3 additions, so omitting them in Phase 1 is correct, not a miss.

### Behaviour preservation

The two halves split cleanly along the original control flow, and the moved code is textually the same apart from closure reads becoming `ctx` reads.

The early returns are the sharpest preservation risk, and both check out. The unclear-route branch produces the same object (`finalText: route.clarifyingQuestion`, empty steps, zero budget, `route`) now nested under `{ kind: 'early', result: {...} }`, and `runAgent` returns `prepared.result` unchanged. The denied-plan branch likewise keeps `toolsConsidered`, `planModel`, the drained `ragJudgments` and `planTracker.plan`. `planModel` is still resolved inside `prepareRun` (`startModelKey || getDefaultModelKey()`), so the early object's `modelKey` is unchanged.

In the loop, `isPinned` was `Boolean(modelKey)` computed after routing set `modelKey = undefined` for the `auto` case; `prepareRun` computes the same `Boolean(modelKey)` into `ctx.isPinned`, and `executeLoop` reads it. `resolveBudget(opts.budget)` is now called once, in `prepareRun`, and passed through `ctx.budgetLimits` — no double resolution. `thinkingBudget`, `abortSignal` and the four callbacks are threaded via `ctx` and spread conditionally, so a run that omitted them before still omits them.

`hadSideEffects` is the single added output. It mirrors the internal `attemptHadSideEffects`, which is still reset per attempt in `callModel` and flipped in `onStepEnd` exactly as before, and still gates the no-restart-after-a-write path inside `executeLoop`. `runAgent` discards the field, so the single-agent `AgentRunResult` is byte-identical to before.

The RAG judgment drain stays in `runAgent` (after `executeLoop` returns), matching the original ordering where the drain happened after the loop settled and before the result was assembled.

### Checkpoint rule: no test, fixture or baseline edits

`git diff main...HEAD --name-status` reports exactly three paths: `A .agents/tasks/ci-task1.md`, `M lib/llm/agent-core.ts`, `M lib/llm/agent.ts`. A filter for `baseline.json`, `*.test.*`, `*.eval.*`, `evals/` and `fixtures/` returns nothing, and the working tree is clean. The task's checkpoint rule — task 1 must be green without touching any existing test, eval fixture or `evals/baseline.json` entry — is satisfied.

### Re-export surface

`agent.ts` re-exports `AgentStepTrace, TokenUsage, ToolOutcome, LoopContext, LoopResult, PreparedRun, EarlyResult` from `agent-core.ts`. The existing consumers of the moved types — `build-run.ts` (`onToolOutcome`), `pricing.ts` and `types.ts` (`TokenUsage`, though those resolve against `lib/types.ts`'s own copy), and `agent.test.ts` — keep their imports. This is why no caller needed editing and the unit suite stayed green.

One observation, not new to this task: `TokenUsage` is now declared in both `lib/types.ts` and `lib/llm/agent-core.ts` with the same shape. The `agent-core.ts` copy is the one moved out of `agent.ts`; the `types.ts` copy already existed. Consolidating to one definition would be a reasonable follow-up but is out of scope for a pure refactor and introduces no behaviour difference.

### CI evidence (read, not re-run)

`.agents/tasks/ci-task1.md` and the commit message record tsc `--noEmit` PASS, lint PASS, `npm test` 481/481 PASS, `next build` PASS. The eval suites (`eval:agent`, `eval:launch`) fail, and the evidence attributes this to live-model/MCP variance, demonstrated by stashing the two modified files and running the evals on the clean baseline: `eval:agent` failed *more* on the baseline (8 vs 7) and `eval:launch` failed identically (6/6), i.e. the failures track the live environment, not the refactor. The deterministic guard is the unit suite, which is green. Per instructions these suites were not re-run; the evidence is present and internally consistent, so there is no cause for a spot-check.

</details>

<details>
<summary>File map</summary>

- `lib/llm/agent-core.ts` — added types-only loop/setup contracts (`LoopContext`, `LoopResult`, `PreparedRun`, `EarlyResult`, `EarlyRunResult`, `ToolApprovalFn`) and moved `TokenUsage`/`ToolOutcome` here; all new imports are `import type`.
- `lib/llm/agent.ts` — extracted `prepareRun` (setup half, returns `EarlyResult` for the two early exits) and `executeLoop` (loop half, returns `hadSideEffects`); `runAgent` reduced to their composition; `TokenUsage`/`ToolOutcome` re-exported.
- `.agents/tasks/ci-task1.md` — CI/eval evidence for the gate.

Full diff: `git -C <worktree> diff main...HEAD`.

</details>
