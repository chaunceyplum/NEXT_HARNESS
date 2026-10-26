# CI evidence — Task 3 (Concurrency limits and configuration)

All commands run inside the worktree
`/Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers`
on branch `feat/orchestrator-workers`.

No review rejection file (`.agents/tasks/review-task3.md`) was present, so this
was a first-iteration implementation, not a fix pass.

## What changed

Subtasks 3.1–3.4, implemented exactly as `tasks.md` lists them.

- **3.1 — `lib/llm/agent-slots.ts` (new) + `agent-slots.test.ts` (new)**: a
  FIFO semaphore on `globalThis` (same pattern as `lib/run-jobs.ts`) bounding
  concurrent agent loops to `MAX_AGENT_LOOPS` (default 12). `acquireLoopSlot(signal?)`
  resolves with an idempotent `release()`; callers over the cap queue in
  arrival order and are served FIFO as slots free. The slot is released on
  success, on a thrown error and on abort. An abort while queued removes the
  waiter from the queue and rejects its promise, without disturbing the
  running count. `maxAgentLoops()` reads the env var (default 12);
  `loopSlotStats()` exposes `{ running, queued, max }` for tests/diagnostics.
  (Reqs 13.1, 13.2)
- **3.2 — `lib/llm/agent.ts`**: `executeLoop` now acquires a slot via
  `acquireLoopSlot(abortSignal)` immediately before the model-call loop and
  releases it in a `finally` that wraps the loop and result assembly, so the
  slot is freed whatever ends the loop — success, provider failure, the
  side-effect fallback refusal, or abort. (Req 13.1)
- **3.3 — `app/api/build/route.ts` + `app/api/build/route.test.ts`**: `POST`
  now returns HTTP `429` with `{ code: 'TOO_MANY_RUNS' }` when
  `activeJobCount() >= maxActiveRuns()` (checked after the kill-switch gate,
  before request validation). New tests assert the 429/`TOO_MANY_RUNS`
  response at the cap and a normal `200` run start under it. (Req 13.3)
- **3.4 — `lib/llm/orchestration-config.ts` (new)**: env readers
  `orchestrationFlag` (`ORCHESTRATION`: off/on/always), `maxWorkers`
  (`MAX_WORKERS`), `workerMaxSteps` (`WORKER_MAX_STEPS`), `workerBudgetShare`
  (`WORKER_BUDGET_SHARE`), `maxReplans` (`MAX_REPLANS`), `workerModel`
  (`WORKER_MODEL`), `launchParallelWrites` (`LAUNCH_PARALLEL_WRITES`) and
  `maxActiveRuns` (`MAX_ACTIVE_RUNS`), each defaulting to the design's
  configuration table and tolerant of malformed values. All variables
  documented in both `.env.local.example` and `ENVIRONMENT_VARIABLES.md`
  (`MAX_AGENT_LOOPS` reader stays in `agent-slots.ts` with the semaphore it
  bounds; it is documented alongside the rest). (Reqs 2.1, 3.1, 4.1, 4.8, 6.1,
  8.2)

Tests were added only where these subtasks specify: `lib/llm/agent-slots.test.ts`
(3.1) and `app/api/build/route.test.ts` (3.3).

## CI gate — all pass

Run fresh inside the worktree:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0, no warnings/errors) |
| `npm test` | PASS — 46 files, **504 passed** |
| `npm run build` | PASS — Next.js compiled successfully, TypeScript checked, 15 static pages, all 23 routes built |

## How to reproduce

```
cd /Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers
npx tsc --noEmit -p . && npm run lint && npm test && npm run build
```
