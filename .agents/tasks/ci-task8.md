# CI evidence — Task 8 (Types, events, record and resume)

Full CI gate run inside the worktree before committing. All four gates green.

## `npx tsc --noEmit -p .`

```
(no output — type check passed; EXIT=0)
```

## `npm run lint`

```
> harness@0.1.0 lint
> eslint
(no output — 0 errors, 0 warnings; EXIT=0)
```

## `npm test`

```
> harness@0.1.0 test
> vitest run

 Test Files  48 passed (48)
      Tests  545 passed (545)
   Duration  ~6.1s
```

545 tests pass (up from 542 at Task 7): the three new Task 8 cases are

- `lib/build-run.test.ts` — resumes an orchestrated run from its done steps
  and their worker results (Requirement 12.4).
- `app/api/build/route.test.ts` — rejects a bad `orchestrate` / `maxWorkers`
  (Task 8.2); and streams `worker_start` / `worker_done`, tags step and
  restart events with `workerId`, drops only the restarted worker's steps,
  and stores `orchestrated` / `replans` / `workers` in the record
  (Requirements 11.1, 11.3, 12.2).

## `npm run build`

```
> harness@0.1.0 build
> next build

✓ Compiled successfully in ~1.6s
  Running TypeScript ... Finished in ~6s
✓ Generating static pages (15/15)
Route (app): /api/build, /api/metrics, /api/runs/[id]/resume, … all built.
EXIT=0
```

## What Task 8 changed

- **8.1** `WorkerStatus`, `WorkerResult`, `WorkerRecord` re-homed to
  `lib/types.ts` (re-exported from `lib/llm/worker.ts` for existing
  importers); `workerId?` added to `AgentStepDTO` and `PlanInfo` steps;
  `orchestrate?` / `maxWorkers?` on `BuildRequest`; `orchestrated?` /
  `replans?` / `workers?` on `BuildResponse`; new `worker_start` /
  `worker_done` stream events and `workerId?` on `step` / `restart` /
  `approval_request`.
- **8.2** `app/api/build/route.ts` validates `orchestrate` (boolean) and
  `maxWorkers` (integer 1–16) and forwards both.
- **8.3** `lib/build-run.ts` forwards `worker_start` / `worker_done`, tags
  step / restart / audit entries with `workerId`, drops only the restarted
  worker's steps from the checkpoint, and checkpoints on worker start/end.
  The producer side (coordinator / agent / worker callback signatures) was
  extended to carry `workerId`: `onWorkerStart`, worker-tagged `onStep`,
  `onToolOutcome` and `onRestart`. A nullable `worker_id` column was added to
  the audit table via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (Requirement
  9.6) — additive and idempotent.
- **8.4** `CHECKPOINT_SCHEMA_VERSION` bumped to 2; workers stored inside the
  existing `result` JSONB (no table DDL for `harness_agent_runs`); v1 records
  are normalised back to single-agent on read (Requirement 12.3).
- **8.5** `resumeContextFrom` resumes an orchestrated run from its done steps
  and their `WorkerResult`s, listing the steps still to do (Requirement 12.4).
- **8.6** The critic and online judge already run on the synthesized answer
  (`rawResult.finalText`) with the merged worker steps (`rawResult.steps`) —
  verified unchanged for the orchestrated path (Requirement 7.3).
- **8.7** `orchestrated`, worker count, replans and per-worker token usage
  added to the production run row and the `/api/metrics` response
  (Requirement 14.2).
- **8.8** Tests added in `lib/build-run.test.ts` and
  `app/api/build/route.test.ts`.

## Notes / limitations

- `approval_request` events from workers carry an optional `workerId`, but the
  shared approval gate (built once in `prepareRun`, before any worker exists)
  does not currently receive the per-call worker id, so worker approval
  requests leave `workerId` unset. This is behaviour-safe (approvals still
  work); a later task can thread the id through the approval gate if the UI
  needs it. Audit entries from workers DO carry `workerId` via the
  `onToolOutcome` path.
