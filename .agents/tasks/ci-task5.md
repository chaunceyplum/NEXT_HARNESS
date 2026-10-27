# CI evidence — Task 5 (Workers)

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

 Test Files  47 passed (47)
      Tests  523 passed (523)
   Duration  ~2.5s
```

523 tests pass (up from 511 at Task 4): the new `lib/llm/worker.test.ts`
adds 12 cases. No existing test, fixture or baseline was changed.

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

- 5.1 `forceFinalTool` added to `LoopContext` and wired into `executeLoop`'s
  `prepareStep`: the last allowed step (or budget wrap-up) forces that tool
  via `toolChoice: { type: 'tool', toolName }` for free-choice models and an
  appended "Call <tool> now." instruction for history-bound models. Unset for
  single-agent runs, so their last-step behaviour is unchanged (Req 4.6).
- 5.2 `lib/llm/worker.ts` `reportResultTool` truncates `summary` to 1,000 and
  `notes` to 500 characters, binds the step id in code (Req 5.1, 5.2).
- 5.3 `workerTools(all, step, catalog)`: step tool + same `PLATFORM_GROUPS`
  group (scoped to real catalog tools) + `find_tools` + `call_tool` +
  `report_result`; excludes `remember_fact`, `update_plan`, `revise_plan`
  (Req 4.2, 4.3).
- 5.4 `buildWorkerBrief`: goal, step, dependency `WorkerResult`s and knowledge;
  no transcripts (Req 4.4, 4.5).
- 5.5 `runWorker`: child `AbortController` linked to the run's signal (Req 9.3);
  child budget sliced from the run ledger via new `RunLedger.childLimits` that
  also charges the ledger through the loop's new `budgetParent` (Req 8.1–8.3);
  `executeLoop` with `forceFinalTool` and `WORKER_MAX_STEPS`; missing-result
  failure "worker ended without a result" (Req 4.7); per-worker same-tier
  fallback with no restart after a write (Req 10.1, 10.2, 10.3); `WORKER_MODEL`
  honoured by passing the resolved model key (Req 4.1, 4.8).
- 5.6 `lib/llm/worker.test.ts`: 12 scripted-tool cases covering tool narrowing,
  exclusions, forced `report_result`, truncation, the missing-result failure,
  fallback before a write, failure after a write, and abort (Req 4.2, 4.6, 4.7,
  10.1, 10.2).
