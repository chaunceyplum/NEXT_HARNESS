# Orchestrator-worker coordinator (Task 6)

Task 6 adds `lib/llm/coordinator.ts`: a deterministic scheduler that runs a multi-step plan as concurrent workers instead of a single agent loop. It resolves per-run config (`orchestrationConfig`) and decides single-agent vs coordinator (`shouldOrchestrate`), runs ready plan steps as workers up to `maxWorkers` while keeping Launch write workers serial, fans each finished `WorkerResult` out to dependants, replans once after a failure (capped at `MAX_REPLANS`), and ends with one streamed synthesis call that has a plain-list fallback. `runAgent` is wired to call `runOrchestrated` when the gate holds and to force planning when orchestration is requested. The change is additive; single-agent runs keep their exact result shape.

Watch for: the abort/ledger-exhaustion stop path (Req 8.4/9.4, task 6.5) and the `step.workerId` assignment (Req 3.5) are implemented but have **no direct test** (confidence: confirmed). Abort is reported as `stopReason: 'time-budget'` rather than a distinct abort reason (confidence: confirmed, minor). CI evidence (`ci-task6.md`) shows all four gates green — tsc, lint, 537 tests (14 new), build.

**Verdict**: APPROVED

## High-level view

The coordinator is deterministic code rather than an LLM loop, which is the right call for a scheduler: the control flow is auditable and testable with scripted workers. `shouldOrchestrate` gates on the flag (`off`/`on`/`always`), the request's `orchestrate` option, and `parallelWidth(plan) >= 2`, so a too-serial plan or a missing plan falls through to the single-agent loop untouched. That gate and the "force planning when orchestration is requested" wiring in `prepareRun` are consistent with each other (both derive the same `orchestrationRequested` predicate).

The scheduler is single-threaded and event-driven: it fills ready slots up to `maxWorkers`, awaits the first worker via `Promise.race`, applies the outcome, and repeats. Serial-write enforcement checks whether any currently-running step is a write/destructive step before starting another write worker, which correctly serialises writes without blocking reads. Dependants receive their dependencies' `WorkerResult`s through the `results` map, keyed by step id.

Replanning is deferred until the running set drains, so the single `generateObject` call sees every finished result — this is the important ordering constraint and the tests assert it directly. The cap (`MAX_REPLANS`) and the replan-failure path both funnel to `skipRemaining`, so no step is ever left dangling. Synthesis is one `streamText` call over every step's status and result, streamed as deltas, with a plain-list fallback on throw so the run always returns an answer.

The known gaps are test coverage, not correctness: the ledger-exhaustion and abort stop paths and the `workerId`-on-step assignment are present and reachable in the code but not exercised by the 14 new cases. The `LaunchValidationGate` is deliberately not threaded to workers yet (Task 7.1); Task 6 only carries `launchMode` via `config.serialWrites`, which the PR notes call out.

<details>
<summary>Issues (3)</summary>

1. **Stop-path untested** — the abort / ledger-exhaustion branch (Req 8.4, 9.4; task 6.5) that halts new workers, drains the running set, and records `stopReason` has no test. Add a case that aborts or exhausts the ledger mid-run and asserts no new workers start and `stopReason` is set.
2. **workerId assignment untested** — `step.workerId` set when a worker starts (Req 3.5) is not asserted on the plan in any test. Add an assertion on `tracker.plan.steps[].workerId` (or on the `onPlan` payload).
3. **Abort labelled as time-budget** — `if (aborted()) stopReason ??= 'time-budget'` reports an abort as a time-budget stop. Minor; consider a distinct reason if downstream (metrics/record in Task 8) needs to tell them apart.

</details>

<details>
<summary>Details</summary>

### Gate and forced planning agree on one predicate

`shouldOrchestrate(flag, requested, plan)` returns false for `off`, false with no plan, then derives `enabled = flag === 'always' ? requested !== false : requested === true` and finally requires `parallelWidth(plan) >= 2`. `prepareRun` computes the same `orchestrationRequested` to force `planFirst`. Because the forced-planning predicate is `orchestrationFlag() !== 'off' && (always ? orchestrate !== false : orchestrate === true)` — identical to the `enabled` clause minus the plan/width checks — a run that will orchestrate always gets a plan built, and a run that only *might* (flag on, no explicit opt-in) does not force planning. The two stay in lockstep, so there's no path where orchestration is gated on but no plan was produced. (confidence: confirmed)

### Serial writes gate on running writes, not all running work

In a Launch run with `serialWrites`, before starting a write/destructive step the scheduler scans the currently-running step ids and skips if any of them is a write step (`isWriteStep` via `classifyTool(...) !== 'read'`). Reads still run concurrently alongside a write, and a second write waits for a free slot *and* no in-flight write. The test `runs write workers one at a time in a Launch run` confirms the second write holds even with a free slot. (confidence: confirmed)

### Replan ordering is the load-bearing constraint

A failed outcome sets `needReplan = true` but the replan only fires when `running.size === 0`, so the one `generateObject` call is built from a `results` map that already contains every finished worker. `tryReplan` increments `replans` first, bails at `MAX_REPLANS`, catches a thrown replan call (logs, returns false), and rejects a revised plan `PlanTracker.revise` refuses. Any false return leads to `skipRemaining()`, which marks every `pending`/`running` step `skipped`. The three replanning tests cover the drain-then-replan ordering, the cap, and the replan-call-throws path. `revise` remaps `dependsOn` to the renumbered plan (kept done steps first, then new steps), which the coordinator relies on and does not re-implement. (confidence: confirmed)

### Synthesis always returns an answer

The single synthesis prompt carries every step's `[status]` and `WorkerResult` (done, failed, skipped). On a thrown call it emits a plain list of step summaries through the same `onTextDelta` hook and returns `finishReason: 'error'`, so a failed provider still yields an answer and a text-delta-only client still sees it. Both the streamed-input assertion (prompt contains the done summary, its ids, the failed summary, and `[failed]`) and the fallback are tested. (confidence: confirmed)

### Stop-on-exhaustion / abort: correct but untested

`haltNew = aborted() || Boolean(ledger.exhausted())` suppresses new scheduling while the loop keeps draining in-flight workers; `stopReason` is captured from `ledger.exhausted()` after each race. After the loop, a guard marks any still-pending step skipped when aborted or exhausted, so nothing dangles. The logic reads correctly and the dependencies (`RunLedger.exhausted` re-checks the clock; workers charge the shared ledger via `budgetParent`) line up. But no test aborts or exhausts the ledger, so this path (task 6.5, Req 8.4/9.4) rests on code reading alone. One nit: an abort is recorded as `stopReason: 'time-budget'`. (confidence: confirmed)

### Test coverage

Covered by the 14 new cases: `orchestrationConfig` min/floor and serial-writes toggle; `shouldOrchestrate` across all flag/request/width combinations; ready-step scheduling and dependant fan-out (3.1/3.3/5.3); the `maxWorkers` cap (3.1/3.2); serial writes (3.4); replan drain + cap + replan-failure skip (6.1/6.3); streamed synthesis input and fallback (7.1/7.2). Worker completion is driven by deferred promises, so overlap is asserted structurally (who is running when) rather than by wall-clock timing — the right approach for deterministic concurrency tests.

Not tested: the abort / ledger-exhaustion stop (Req 8.4/9.4); `step.workerId` set on the plan (Req 3.5); the `onPlan` status-transition notifications. These are reachable branches with no assertion behind them.

### runAgent wiring is additive

`AgentRunResult` gains optional `orchestrated`/`replans`/`workers`, `RunAgentOptions` gains `orchestrate`/`maxWorkers`/`onWorker`, and `PlanStep` gains optional `workerId` — all optional, so single-agent results are byte-compatible. The orchestrated branch assembles `OrchestratorInput` from the `PreparedRun` (tools, catalog from `getMcpToolCatalog` only when tools weren't injected, planning knowledge, run model, budget, health, approval gate, tracer attrs, stream hooks) and merges `ragJudgments`/`versions`/`route` back in afterward, matching the single-agent assembly. The `onRestart` adapter drops the coordinator's extra `workerId` field to fit the existing `RunAgentOptions.onRestart` shape, which is fine for Task 6 (richer worker events land in Task 8.3). (confidence: confirmed)

</details>

<details>
<summary>Files changed</summary>

- `lib/llm/coordinator.ts` (new, 552) — config/gate, scheduler loop, replanning, synthesis.
- `lib/llm/coordinator.test.ts` (new, 364) — 14 scripted-worker cases.
- `lib/llm/agent.ts` (+76) — `runOrchestrated` call site, forced planning, result/option/field additions.
- `lib/llm/planner.ts` (+7) — optional `PlanStep.workerId`.
- `.kiro/specs/orchestrator-workers/tasks.md` — task 6 marked done.
- `.agents/tasks/ci-task6.md` (new) — CI evidence.

Full diff: `git show HEAD` on `feat/orchestrator-workers` (commit 8c88c56).

</details>
