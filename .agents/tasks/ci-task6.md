# CI evidence — Task 6 (Coordinator)

Full CI gate run inside the worktree before committing. All four gates green.

## `npx tsc --noEmit -p .`

```
(no output — type check passed)
```

## `npm run lint`

```
> harness@0.1.0 lint
> eslint
(no output — 0 errors, 0 warnings)
```

## `npm test`

```
> harness@0.1.0 test
> vitest run

 Test Files  48 passed (48)
      Tests  537 passed (537)
   Duration  ~6.9s
```

537 tests pass (up from 523 at Task 5): the new `lib/llm/coordinator.test.ts`
adds 14 cases. No existing test, fixture or baseline was changed.

## `npm run build`

```
> harness@0.1.0 build
> next build

Route (app)
┌ ○ /
├ ƒ /api/build
├ ƒ /api/metrics
└ … (all routes compiled; static + dynamic as before)

Compiled successfully.
```

## Scope verified

- 6.1 `lib/llm/coordinator.ts` adds `orchestrationConfig(req, launchMode)` —
  `maxWorkers = min(MAX_WORKERS, request.maxWorkers)`, `maxReplans`,
  `workerMaxSteps`, optional `workerModelKey`, and `serialWrites` (true in a
  Launch run unless `LAUNCH_PARALLEL_WRITES`) — and `shouldOrchestrate(flag,
  requested, plan)`: off ignores the request, `on` needs `orchestrate: true`,
  `always` runs unless `orchestrate: false`, and a plan whose
  `parallelWidth < 2` (or no plan) always runs single-agent (Req 2.2–2.5).
- 6.2 `runOrchestrated` scheduler loop: starts ready steps (`readySteps`) up to
  `maxWorkers`; keeps write workers serial in Launch runs when `serialWrites`
  (Req 3.4); marks a step `running` and sets its `workerId` when its worker
  starts (Req 3.5); `tool === null` steps are kept for synthesis, never run as
  workers (Req 3.7); a finished worker's `WorkerResult` is stored and handed to
  its dependants' briefs (Req 3.3, 5.3) and the step is marked `done`/`failed`
  (Req 5.4). `maxWorkers` is never exceeded (Req 3.1, 3.2).
- 6.3 Replanning: a failed step sets `needReplan`, which fires only once the
  running set drains, so the one `generateObject` replan call sees every
  finished result (Req 6.1); the revised steps go through `PlanTracker.revise`,
  keeping each new step's `dependsOn` (Req 6.2); at `MAX_REPLANS` or on a
  replan-call failure the remaining steps are marked `skipped` and the run goes
  to synthesis (Req 6.3).
- 6.4 Synthesis: one `streamText` call built from the goal and every step's
  status + `WorkerResult` (done, failed and skipped), streamed as `text_delta`
  (Req 7.1, 7.2); on a thrown synthesis call it falls back to a plain list of
  the step summaries with `finishReason: 'error'`.
- 6.5 The scheduler stops starting new workers when `ledger.exhausted()` or the
  run is aborted, drains the workers already running, and records `stopReason`
  (Req 8.4, 9.4). Each worker's own loop still forces its wrap-up via the shared
  ledger (`budgetParent`).
- 6.6 `lib/llm/coordinator.test.ts`: 14 scripted-worker cases (worker
  completion driven by deferred promises, so overlap is asserted from who is
  running when, not wall-clock timing) covering ready-step scheduling and
  dependants (Req 3.1, 3.3), the `maxWorkers` cap (3.2), serial writes (3.4),
  the replan drain + cap + replan-failure skip (6.1, 6.3), and the streamed
  synthesis input + fallback (7.1, 7.2), plus `orchestrationConfig` /
  `shouldOrchestrate`.
- 6.7 `runAgent` calls `runOrchestrated` when `shouldOrchestrate(orchestrationFlag(),
  opts.orchestrate, plan)` holds, assembling the coordinator's `OrchestratorInput`
  from the `PreparedRun` (tools, catalog from `getMcpToolCatalog`, planning
  knowledge, run model, budget limits, health, approval gate, tracer attrs and
  the stream hooks); `prepareRun` forces planning as if `planFirst` were set
  when orchestration is requested (Req 2.3, 2.4, 2.6). `RunAgentOptions` gains
  `orchestrate`, `maxWorkers`, `onWorker`; `AgentRunResult` gains
  `orchestrated`, `replans`, `workers`; `PlanStep` gains `workerId`. Single-agent
  runs are unchanged (no plan or `parallelWidth < 2` → the single loop runs as
  before).

## Notes

- Next.js APIs: Task 6 touches only `lib/llm` (the coordinator, the worker
  wiring and `runAgent`); no Next.js route, component or framework API was
  written, so the modified-Next.js guide under `node_modules/next/dist/docs/`
  did not apply to any code changed here.
- The shared `LaunchValidationGate` is threaded to workers in Task 7.1; Task 6
  only needs `launchMode` (carried as `config.serialWrites`) to keep Launch
  write workers serial.
