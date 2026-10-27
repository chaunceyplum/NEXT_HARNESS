# Implementation Plan

Each top-level task is one PR. Do them in order. Every PR must pass
`npx tsc --noEmit -p .`, `npm run lint`, `npm test` and `npm run build`
(the CI workflow) before the next task starts.

**Checkpoint rule for task 1:** it is a pure refactor. If any existing test,
eval fixture or `evals/baseline.json` entry has to change for it to pass,
stop. That means behaviour changed, and it must be fixed before going on.

- [ ] 1. Split `runAgent` into `prepareRun` and `executeLoop` (no behaviour change)
- [ ] 1.1 Add `LoopContext`, `LoopResult`, `PreparedRun` and `EarlyResult` types to `lib/llm/agent-core.ts`
  - Types only; no imports of the live MCP client
  - _Requirements: 1.1, 1.2_
- [ ] 1.2 Extract `executeLoop(ctx)` from `runAgent` (`lib/llm/agent.ts` lines ~1062–1330)
  - Move tracer setup, budget, `callModel`, the fallback loop and result assembly
  - Replace every closure read with a `ctx` field; return `hadSideEffects`
  - _Requirements: 1.2_
- [ ] 1.3 Extract `prepareRun(opts)` from `runAgent` (lines ~823–1060)
  - Return `EarlyResult` for the unclear-route and denied-plan cases
  - _Requirements: 1.1_
- [ ] 1.4 Re-implement `runAgent` as `prepareRun` then `executeLoop`, assembling the same `AgentRunResult`
  - _Requirements: 1.3, 1.4_
- [ ] 1.5 Run the full suite and `npm run eval:agent` / `npm run eval:launch` with no test, fixture or baseline changes
  - _Requirements: 1.5_

- [x] 2. Planner support for parallel steps
- [x] 2.1 Keep `dependsOn` in `PlanTracker.revise` and add optional `dependsOn` to the `revise_plan` schema (`lib/llm/planner.ts`)
  - Remap ids to the renumbered steps; drop references to removed steps
  - Unit tests in `lib/llm/planner.test.ts`
  - _Requirements: 6.4_
- [x] 2.2 Reject cycles and unknown ids in `normalisePlan`
  - _Requirements: 3.6_
- [x] 2.3 Add `readySteps(plan)` and `parallelWidth(plan)` with tests
  - _Requirements: 2.5, 3.3_
- [x] 2.4 Set `dependsOn` in the Launch template (`lib/llm/launch-plan.ts`): read state → data elements → rules → validate → library (→ publish)
  - Update `lib/llm/launch-plan.test.ts`
  - _Requirements: 9.2_

- [x] 3. Concurrency limits and configuration
- [x] 3.1 Add `lib/llm/agent-slots.ts` (FIFO semaphore on `globalThis`, `MAX_AGENT_LOOPS`) with `agent-slots.test.ts`
  - Release on success, error and abort; abort while queued removes the waiter
  - _Requirements: 13.1, 13.2_
- [x] 3.2 Acquire a slot in `executeLoop` before the first model call; release in `finally`
  - _Requirements: 13.1_
- [x] 3.3 Return 429 with code `TOO_MANY_RUNS` from `POST /api/build` when `activeJobCount() >= MAX_ACTIVE_RUNS`; test in `app/api/build/route.test.ts`
  - _Requirements: 13.3_
- [x] 3.4 Add config readers for `ORCHESTRATION`, `MAX_WORKERS`, `WORKER_MAX_STEPS`, `WORKER_BUDGET_SHARE`, `MAX_REPLANS`, `WORKER_MODEL`, `LAUNCH_PARALLEL_WRITES`; document all variables in `.env.local.example` and `ENVIRONMENT_VARIABLES.md`
  - _Requirements: 2.1, 3.1, 4.1, 4.8, 6.1, 8.2_

- [x] 4. Shared run budget
- [x] 4.1 Add `RunLedger` and parent charging to `RunBudgetTracker` (`lib/llm/run-budget.ts`)
  - `child(modelKey, share)`; `recordStep` charges child and parent; `exceeded()` reports either
  - Single-agent path uses a tracker with no parent (unchanged behaviour)
  - Tests in `lib/llm/run-budget.test.ts`
  - _Requirements: 8.1, 8.2, 8.3, 8.5_

- [x] 5. Workers
- [x] 5.1 Add `forceFinalTool` to `executeLoop`: last or wrap-up step forces that tool; history-bound models get an appended instruction instead
  - _Requirements: 4.6_
- [x] 5.2 Create `lib/llm/worker.ts` with `reportResultTool` (truncate summary to 1,000 and notes to 500 characters)
  - _Requirements: 5.1, 5.2_
- [x] 5.3 Implement `workerTools(all, step, catalog)`: step tool + same `PLATFORM_GROUPS` group + `find_tools` + `call_tool` + `report_result`; exclude `remember_fact`, `update_plan`, `revise_plan`
  - _Requirements: 4.2, 4.3_
- [x] 5.4 Implement the worker brief builder (goal, step, dependency `WorkerResult`s, knowledge; no transcripts)
  - _Requirements: 4.4, 4.5_
- [x] 5.5 Implement `runWorker`: child abort controller, child budget, `executeLoop`, missing-result handling, per-worker fallback and no restart after a write
  - _Requirements: 4.1, 4.7, 4.8, 5.4, 9.3, 10.1, 10.2, 10.3_
- [x] 5.6 Write `lib/llm/worker.test.ts` with scripted tools
  - _Requirements: 4.2, 4.6, 4.7, 10.1, 10.2_

- [ ] 6. Coordinator
- [ ] 6.1 Create `lib/llm/coordinator.ts` with `orchestrationConfig` and `shouldOrchestrate`
  - _Requirements: 2.2, 2.3, 2.4, 2.5_
- [ ] 6.2 Implement the scheduler loop: ready steps up to `maxWorkers`, serial write workers in Launch runs, step status and `workerId`, results to dependants
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 5.3, 5.4_
- [ ] 6.3 Implement replanning after failures (wait for running workers; `MAX_REPLANS`; skip remaining on cap or failure)
  - _Requirements: 6.1, 6.2, 6.3_
- [ ] 6.4 Implement synthesis (streamed; plain list fallback on failure)
  - _Requirements: 7.1, 7.2_
- [ ] 6.5 Stop on ledger exhaustion and on abort
  - _Requirements: 8.4, 9.4_
- [ ] 6.6 Write `lib/llm/coordinator.test.ts` using controlled-delay scripted tools to assert overlap and ordering
  - _Requirements: 3.1, 3.3, 3.4, 6.1, 6.3, 7.1_
- [ ] 6.7 Call `runOrchestrated` from `runAgent` when `shouldOrchestrate` is true; force planning when orchestration is requested
  - _Requirements: 2.3, 2.4, 2.6_

- [ ] 7. Shared safety state and observability
- [ ] 7.1 Pass the run's single `LaunchValidationGate` to every worker; verify the gate still blocks the library handoff until checks pass
  - _Requirements: 9.1, 9.2_
- [ ] 7.2 Route worker tool calls through the existing approval hook; allow several pending approvals per run
  - _Requirements: 9.5_
- [ ] 7.3 Add `SpanRef` to `lib/tracing.ts`; record coordinator and per-worker child spans with worker attributes
  - _Requirements: 14.1_
- [ ] 7.4 Verify a kill-switch trip aborts every worker (`lib/kill-switch.test.ts`)
  - _Requirements: 9.4_

- [ ] 8. Types, events, record and resume
- [ ] 8.1 Add `WorkerStatus`, `WorkerResult`, `WorkerRecord` and the changed fields to `lib/types.ts`
  - _Requirements: 5.1, 11.1, 11.2, 11.3, 12.1_
- [ ] 8.2 Accept and validate `orchestrate` and `maxWorkers` in `app/api/build/route.ts`
  - _Requirements: 2.3, 2.4, 3.2_
- [ ] 8.3 In `lib/build-run.ts`: forward `worker_start` / `worker_done`; tag events and audit entries with `workerId`; per-worker restart in checkpoints; checkpoint on worker start and end
  - _Requirements: 9.6, 11.1, 11.2, 11.3, 11.5, 12.2_
- [ ] 8.4 Bump `CHECKPOINT_SCHEMA_VERSION` to 2 in `lib/execution-store.ts`; store workers in `result` JSONB; load version 1 records as single-agent
  - _Requirements: 12.1, 12.3_
- [ ] 8.5 Resume orchestrated runs from `done` steps in `resumeContextFrom`
  - _Requirements: 12.4_
- [ ] 8.6 Run critic and judge on the synthesized answer with merged worker steps
  - _Requirements: 7.3_
- [ ] 8.7 Add orchestration fields to the run record and `/api/metrics`
  - _Requirements: 14.2_
- [ ] 8.8 Tests in `lib/build-run.test.ts` and `app/api/build/route.test.ts`
  - _Requirements: 11.1, 11.3, 12.2, 12.4_

- [ ] 9. User interface
- [ ] 9.1 Handle `worker_start`, `worker_done` and per-worker `restart` in `app/page.tsx`; keep a map of pending approvals
  - _Requirements: 11.4, 15.3_
- [ ] 9.2 Group steps into worker lanes in `components/AgentTrace.tsx`
  - _Requirements: 15.1_
- [ ] 9.3 Show concurrent `running` steps linked to lanes in `components/PlanView.tsx`
  - _Requirements: 15.2_
- [ ] 9.4 Render stored workers in `app/results/[id]/page.tsx`
  - _Requirements: 15.4_

- [ ] 10. Evals and rollout check
- [ ] 10.1 Make `evals/lib/scripted-tools.ts` answer by tool name + input, independent of call order
  - _Requirements: 16.1_
- [ ] 10.2 Add `EVAL_ORCHESTRATE` (`off` | `on` | `both`) to `evals/launch.eval.ts` and `evals/agent.eval.ts`, with side-by-side reporting
  - _Requirements: 16.2_
- [ ] 10.3 Add agent eval fixtures with independent steps and one forced worker failure
  - _Requirements: 16.4_
- [ ] 10.4 Add orchestrated baseline keys to `evals/baseline.json` and `scripts/check-eval-baseline.mjs`
  - _Requirements: 16.3_
- [ ] 10.5 Run both modes on the Launch fixtures and record results against the rollout bar in the introduction of `requirements.md`
  - _Requirements: 16.2_
