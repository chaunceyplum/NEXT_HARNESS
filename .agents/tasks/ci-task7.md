# CI evidence — Task 7 (Shared safety state and observability)

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
      Tests  542 passed (542)
   Duration  ~5.8s
```

542 tests pass (up from 537 at Task 6): the five new Task 7 cases are the
gate-still-blocks-for-a-worker case in `lib/llm/worker.test.ts`, the
several-pending-approvals case in `lib/llm/approvals.test.ts`, the
parent/child `SpanRef` nesting case in `lib/tracing.test.ts`, the
coordinator-span/`tracerParent` case in `lib/llm/coordinator.test.ts`, and the
kill-switch-aborts-every-worker case in `lib/kill-switch.test.ts`. No existing
test, fixture or baseline was changed.

## `npm run build`

```
▲ Next.js 16.4.1 (Turbopack)
✓ Compiled successfully in 2.5s
  Finished TypeScript in 4.6s
✓ Generating static pages (15/15)
Route (app) — all routes compiled (static + dynamic as before)
EXIT=0
```

## Scope verified

- **7.1 — one shared `LaunchValidationGate` per run, handed to every worker
  (Req 9.1, 9.2).** The gate is built once in `prepareRun` and embedded in the
  run's tool set (`buildAiTools(..., { launchGate })`), so the SAME instance is
  what every worker's narrowed tool set (`workerTools`) calls through — no
  worker gets a bypass. The gate is now also carried on `LoopContext.launchGate`
  so `runAgent` passes it to `runOrchestrated` (coordinator → `SharedRunState.
  launchGate` → each worker's `LoopContext`), which both tells a worker it is in
  a gated Launch run (worker `launchMode` grounding) and makes the shared
  instance explicit. New worker test: a gate seeded to block a handoff (a
  created rule component referencing an uninstalled extension) still blocks the
  `reactor_create_library` write when the call comes from a worker — the write
  never completes and the step is `failed`.
- **7.2 — worker tool calls route through the existing approval hook; several
  pending approvals per run (Req 9.5).** The run's single `toolApproval` gate
  (agent.ts) is shared through `SharedRunState.toolApproval` → each worker's
  `LoopContext.toolApproval`, so a worker's risky call is gated exactly like a
  single-agent one. The approvals registry (`lib/llm/approvals.ts`) is keyed by
  `runId:toolCallId`, so concurrent workers' calls coexist as distinct pending
  entries. New approvals test: three approvals pending at once for one run
  resolve independently (approve one, the other two stay pending, then deny /
  approve each separately).
- **7.3 — `SpanRef` + coordinator and per-worker child spans (Req 14.1).** Added
  `SpanRef { traceId, spanId }` to `lib/tracing.ts`; `RunTracer` takes an
  optional `parent: SpanRef` (its root joins the parent's trace id and is
  parented to the parent span) and exposes `ref()`. `LoopContext`,
  `SharedRunState`, `WorkerInput` and `OrchestratorInput` gain `tracerParent`.
  The coordinator opens one coordinator span (`harness.orchestration=true`),
  hands its `ref()` to every worker as `tracerParent` (so each worker's trace
  nests under it — coordinator → worker → step), records a summary child span
  per finished worker (worker id, step, attempt, status, model, token spend),
  and exports the coordinator span + worker summary spans on finish (best-effort,
  like `executeLoop`). New tests: `RunTracer` nests a child tracer under a parent
  `SpanRef` sharing its trace id (tracing.test.ts), and the coordinator hands the
  same `tracerParent` to every worker (coordinator.test.ts).
- **7.4 — a kill-switch trip aborts every worker (Req 9.4).** `lib/kill-switch.
  test.ts` now starts three real workers (`runWorker`) that share one run's
  `AbortController` (registered with the kill switch) and hang on their first
  model call until their child abort signal fires; one `engageKillSwitch` call
  aborts the run signal, every worker's linked child controller aborts, and all
  three workers end `cancelled` — not just one.

## Notes

- Next.js APIs: Task 7 touches only `lib/llm`, `lib/tracing.ts` and
  `lib/kill-switch.test.ts`; no Next.js route, component or framework API was
  written, so the modified-Next.js guide under `node_modules/next/dist/docs/`
  did not apply to any code changed here.
- No user-visible behaviour changed: the gate, the approval hook and the abort
  path already existed for single-agent runs; Task 7 shares those exact
  instances across workers and adds trace spans (export is best-effort and never
  disturbs the run).
