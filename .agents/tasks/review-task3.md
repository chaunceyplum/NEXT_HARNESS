# Review — Task 3: Concurrency limits and configuration

Reviewed commit `75c42a4` on `feat/orchestrator-workers` against the approved
spec (`requirements.md`, `design.md`, `tasks.md`) for subtasks 3.1–3.4. CI
evidence read from `.agents/tasks/ci-task3.md` (not re-run).

The change adds a process-wide FIFO semaphore bounding concurrent agent loops
(`MAX_AGENT_LOOPS`), wires it into `executeLoop`, adds a `429 TOO_MANY_RUNS`
guard on `POST /api/build`, and centralizes the orchestrator-worker env readers
in a new `orchestration-config.ts`, documented in both env files. Scope is
confined to Task 3's subtasks — no later-task code (workers, coordinator,
budget ledger) leaked in.

**Verdict**: APPROVED

## What I verified

**3.1 — agent-slots.ts FIFO semaphore (Reqs 13.1, 13.2).** State lives on
`globalThis.__harnessAgentSlots` (same pattern as `run-jobs.ts`), so dev-mode
module reloading won't split it. `acquireLoopSlot(signal?)` grants immediately
when `running < maxAgentLoops()` and otherwise queues a waiter; `releaseSlot`
hands a freed slot straight to the head of the queue (keeping `running`
constant across the handoff) or decrements when the queue is empty. The
returned `release()` is guarded by a `released` flag so repeated calls are
no-ops. Abort handling is correct on both paths: an already-aborted signal
rejects before taking a slot, and an abort while queued splices the waiter out
and rejects without touching `running`. `maxAgentLoops()` defaults to 12,
floors at 1, and tolerates malformed input. The grant comment correctly notes
the slot was never released on the waiter's behalf, so grant must not
re-increment — verified against `releaseSlot`, which does not decrement when it
hands off.

`agent-slots.test.ts` covers the behaviors the subtask calls out: the
default/env-read of `maxAgentLoops`, grant-then-queue at the cap, FIFO ordering
across three waiters, idempotent release, release-in-finally after a throw,
immediate rejection on a pre-aborted signal, and abort-while-queued leaving
`running` untouched while later handoffs still work. The `afterEach` asserts
the semaphore drains to `{ running: 0, queued: 0 }`, which catches a leak
before it bleeds into the next test.

**3.2 — slot acquire/release in executeLoop (Req 13.1).** `acquireLoopSlot(abortSignal)`
is awaited immediately before the model-call loop, and `releaseSlot()` is the
sole statement in a `finally` wrapping the entire loop plus result assembly.
Every exit — success, provider failure with no fallback, the side-effect
fallback refusal, and abort — flows through that `finally`, so the slot is
always freed. The acquire sits before `callModel`, so a worker that can't get a
slot queues without burning a model call, and an abort while queued rejects
before any provider work.

**3.3 — 429 TOO_MANY_RUNS (Req 13.3).** `POST /api/build` now checks
`activeJobCount() >= maxActiveRuns()` and returns `429` with
`{ code: 'TOO_MANY_RUNS' }`. Placement is correct: after the kill-switch 503
gate, before `validateRequest`, so an overloaded instance rejects cheaply.
`activeJobCount` is a real export in `run-jobs.ts` (line 47). The route test
mocks `orchestration-config` with a controllable cap, asserts `429`/`TOO_MANY_RUNS`
at the cap and a normal `200` `run_start` under it, and cancels the started run
so it doesn't leak into later tests.

**3.4 — config readers + documentation (Reqs 2.1, 3.1, 4.1, 4.8, 6.1, 8.2).**
`orchestration-config.ts` exports all seven readers the subtask names —
`orchestrationFlag` (off/on/always, unknown→off), `maxWorkers`, `workerMaxSteps`,
`workerBudgetShare` (clamped to (0,1]), `maxReplans` (floor 0), `workerModel`
(undefined when unset), `launchParallelWrites` — plus `maxActiveRuns` used by
3.3. Each falls back to its documented default on unset/malformed input, so a
bad value degrades to default rather than crashing a run. `maxAgentLoops` stays
in `agent-slots.ts` with the semaphore it bounds, which is a reasonable
cohesion choice and is called out in the config file's doc comment.

All seven readers — plus `MAX_AGENT_LOOPS` and `MAX_ACTIVE_RUNS` — appear in
both `.env.local.example` and `ENVIRONMENT_VARIABLES.md` (verified by grep;
every variable present in both). The `ENVIRONMENT_VARIABLES.md` table documents
defaults and effects accurately against the reader implementations (e.g.
`WORKER_BUDGET_SHARE` clamp, `MAX_REPLANS` floor, `MAX_AGENT_LOOPS` FIFO
queueing and minimum 1).

**tasks.md.** Task 3 and all four subtasks (3.1–3.4) are flipped to `[x]`.
Tasks 1 and 4+ remain unchecked, as expected.

**CI evidence.** `ci-task3.md` records `tsc --noEmit`, `lint`, `test`
(504 passed across 46 files) and `build` all passing. Evidence file present and
consistent with the diff. Not re-run per instructions.

## Findings

None blocking.

Minor, non-blocking observation (no action required for this task): the
`429 TOO_MANY_RUNS` guard counts total active jobs via `activeJobCount()`, which
is the run-level cap described by Req 13.3. The separate `MAX_AGENT_LOOPS` cap
bounds loops within the process. The two are independent ceilings by design, as
the code comments state; nothing to change here.

## Reasoning

The diff implements exactly the four subtasks with tests for the two that
specify them (3.1, 3.3), the semaphore's abort and FIFO semantics are correct
on every path I traced, the slot lifecycle in `executeLoop` is leak-free
through its `finally`, the 429 path is correctly ordered and tested, and the
config surface is complete and documented in both required files. No
out-of-scope changes. Approving.
