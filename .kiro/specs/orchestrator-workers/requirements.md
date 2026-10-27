# Requirements Document

## Introduction

Add an orchestrator-worker mode to the harness agent. Today every run is a
single agent loop (`runAgent` in `lib/llm/agent.ts`) that executes the whole
plan itself. In the new mode, a code-based coordinator runs plan steps whose
dependencies are done as concurrent worker agents. Each worker is a smaller
agent loop with a narrow tool set and a step cap. Workers return structured
results that the coordinator passes to dependent steps and, finally, to a
synthesis call that writes the answer.

Everything runs inside the existing single Node process and Docker container.
No new infrastructure is added. The single-agent path stays the default and
must behave exactly as it does today.

### Decisions taken for this spec

These were open questions; the defaults below apply until changed.

- **Coordinator type:** deterministic code, not an LLM loop. An LLM
  coordinator (`delegate_task` tool) is out of scope.
- **Reactor writes:** parallel creates in one Launch property are NOT assumed
  safe. In Launch runs, workers that write run one at a time
  (`LAUNCH_PARALLEL_WRITES=false`); read steps and non-Launch steps run in
  parallel. Parallel Launch writes can be enabled later once verified.
- **Worker model:** the run's model by default; `WORKER_MODEL` can set a
  cheaper one.
- **Rollout bar:** orchestration becomes the default only when it matches or
  beats single-agent pass rate on the Launch eval fixtures, with at least 30%
  lower median wall-clock time and no more than 25% higher cost.

### Rollout check results (Task 10.5)

Both modes were run side by side with `EVAL_ORCHESTRATE=both` on the Launch
and agent fixtures (`anthropic:sonnet`, judge `anthropic:opus-5-5`, k=1). Full
evidence is in `.agents/tasks/ci-task10.md`.

Launch suite (6 fixtures) — the rollout bar:

| metric            | single-agent | orchestrated |
|-------------------|-------------:|-------------:|
| pass rate         |           0% |           0% |
| median wall-clock |        25.2s |        23.8s |
| total cost        |      $0.1607 |          n/a |
| safety violations |            0 |            0 |

Rollout-bar check: pass-rate parity held (0% → 0%), median wall-clock only
-6% (needs ≤ -30%), cost not comparable (n/a). **Orchestration does NOT clear
the rollout bar on this run, so it stays off by default (`ORCHESTRATION=off`).**
On this run the model made almost no tool calls on the Launch fixtures in
single-agent mode (it stopped to ask for IDs), so both modes score 0% and the
pass-rate parity is vacuous; the wall-clock and cost gates are not met. The
comparison harness, the side-by-side reporting and the rollout-bar check all
function as intended — re-running with a model that completes the Launch
fixtures will produce a non-trivial comparison without any code change.

For reference, the agent suite (20 fixtures) showed orchestrated pass rate
79% vs 75% single-agent, at higher median wall-clock (22.5s vs 11.2s) and
tokens/success (26,843 vs 8,348), with zero safety violations in both modes.

### Glossary

- **Run:** one agent job started by `POST /api/build` or a resume.
- **Plan:** the `Plan` object from `lib/llm/planner.ts` (or the Launch
  template from `lib/llm/launch-plan.ts`).
- **Ready step:** a plan step with status `pending` whose `dependsOn` steps
  are all `done`.
- **Coordinator:** the code that schedules ready steps as workers.
- **Worker:** one agent loop (`executeLoop`) that carries out one plan step.
- **WorkerResult:** the structured result a worker reports with the
  `report_result` tool.
- **Run ledger:** the run-level token, cost and time budget shared by all
  workers.

## Requirements

### Requirement 1: Behaviour-preserving split of the agent loop

**User Story:** As a maintainer, I want the agent's setup and its loop to be
separate functions, so that workers can reuse the loop without duplicating
code or changing single-agent behaviour.

#### Acceptance Criteria

1. THE SYSTEM SHALL expose `prepareRun(opts)` that performs routing, launch
   mode resolution, validation gate creation, Launch brief parsing, tool
   selection, memory loading, planning retrieval, planning, plan approval and
   approval hook construction.
2. THE SYSTEM SHALL expose `executeLoop(ctx)` that performs the streaming
   tool loop, budget enforcement, context compression, same-tier fallback,
   tracing and result assembly, reading all inputs from `ctx` and none from
   enclosing closures.
3. THE SYSTEM SHALL keep `runAgent(opts)` with an unchanged signature and an
   unchanged `AgentRunResult` shape, implemented as `prepareRun` followed by
   `executeLoop`.
4. WHEN orchestration is off, THE SYSTEM SHALL produce the same tool calls,
   stream events, stored record and final answer as before the split.
5. WHEN the split is complete, THE SYSTEM SHALL pass `npm test`,
   `npm run lint`, `npx tsc --noEmit -p .`, `npm run build`, and the
   `eval:agent` and `eval:launch` suites without changes to tests, fixtures or
   `evals/baseline.json`.

### Requirement 2: Enabling orchestration

**User Story:** As an operator, I want orchestration behind a flag and a
per-request option, so that I can roll it out gradually.

#### Acceptance Criteria

1. THE SYSTEM SHALL read `ORCHESTRATION` with values `off` (default), `on`
   and `always`.
2. WHEN `ORCHESTRATION=off`, THE SYSTEM SHALL ignore the request's
   `orchestrate` option and run single-agent.
3. WHEN `ORCHESTRATION=on` AND the request sets `orchestrate: true` AND the
   run has a plan, THE SYSTEM SHALL use the coordinator.
4. WHEN `ORCHESTRATION=always` AND the run has a plan, THE SYSTEM SHALL use
   the coordinator unless the request sets `orchestrate: false`.
5. WHEN the plan has fewer than two steps that could ever run at the same
   time, THE SYSTEM SHALL run single-agent even if orchestration was
   requested, and SHALL record `orchestrated: false` on the result.
6. WHEN orchestration is requested and `planFirst` is not set, THE SYSTEM
   SHALL make a plan as if `planFirst` were true.

### Requirement 3: Scheduling workers

**User Story:** As a user, I want independent steps of my request to run at
the same time, so that multi-step runs finish sooner.

#### Acceptance Criteria

1. WHEN a step becomes ready, THE SYSTEM SHALL start a worker for it, as long
   as fewer than `MAX_WORKERS` (default 3) workers of this run are running.
2. WHEN `BuildRequest.maxWorkers` is set, THE SYSTEM SHALL use the smaller of
   it and `MAX_WORKERS`.
3. THE SYSTEM SHALL start no worker for a step until every step in its
   `dependsOn` has status `done`.
4. WHILE a Launch run has `LAUNCH_PARALLEL_WRITES=false`, THE SYSTEM SHALL
   run at most one worker at a time whose step tool is classified as write or
   destructive.
5. THE SYSTEM SHALL mark a step `running` when its worker starts and set the
   step's `workerId`.
6. WHEN a plan contains a dependency cycle or a `dependsOn` id that does not
   exist, THE SYSTEM SHALL reject the plan and run single-agent.
7. THE SYSTEM SHALL keep steps that only reason or write the answer
   (`tool: null`) for the synthesis call instead of starting a worker for
   them.

### Requirement 4: Worker execution

**User Story:** As a maintainer, I want each worker to be a small, bounded
agent with only the tools its step needs, so that its context stays small
and its mistakes stay contained.

#### Acceptance Criteria

1. THE SYSTEM SHALL run each worker through `executeLoop` with
   `maxSteps = WORKER_MAX_STEPS` (default 6).
2. THE SYSTEM SHALL give a worker the step's tool, the other tools of that
   tool's platform group in `PLATFORM_GROUPS`, `find_tools`, `call_tool` and
   `report_result`, filtered by the run's tool policy, dry-run and rollout
   mode.
3. THE SYSTEM SHALL NOT give workers `remember_fact`, `update_plan` or
   `revise_plan`.
4. THE SYSTEM SHALL build the worker's first message from the run goal, the
   step's description, tool and expected output, the `WorkerResult` of each
   step in its `dependsOn`, and the planning knowledge excerpts.
5. THE SYSTEM SHALL NOT include other workers' transcripts in a worker's
   messages.
6. WHEN a worker reaches its last allowed step, THE SYSTEM SHALL force a
   `report_result` call on that step.
7. WHEN a worker ends without a valid `report_result` call, THE SYSTEM SHALL
   treat the step as failed with the error "worker ended without a result".
8. WHEN `WORKER_MODEL` is set, THE SYSTEM SHALL run workers on that model and
   the coordinator's synthesis on the run's model.

### Requirement 5: Worker results

**User Story:** As a maintainer, I want workers to hand back structured
results, so that dependent steps get the ids they need without parsing prose.

#### Acceptance Criteria

1. THE SYSTEM SHALL define `report_result` with input
   `{ status: 'done' | 'failed', summary: string, ids: Record<string,string>, notes?: string }`.
2. THE SYSTEM SHALL truncate `summary` to 1,000 characters and `notes` to
   500 characters.
3. WHEN a worker reports `done`, THE SYSTEM SHALL mark its step `done`,
   store the `WorkerResult`, and schedule any newly ready steps.
4. WHEN a worker reports `failed`, throws, or is stopped by its budget, THE
   SYSTEM SHALL mark its step `failed` and store the error.

### Requirement 6: Replanning after failure

**User Story:** As a user, I want the run to adapt when a step fails, so that
one failure doesn't end the whole request.

#### Acceptance Criteria

1. WHEN a step fails AND fewer than `MAX_REPLANS` (default 2) replans have
   happened in this run, THE SYSTEM SHALL wait for running workers to finish
   and then make one replanning call with the goal, the completed results and
   the failure.
2. WHEN the replanning call returns steps, THE SYSTEM SHALL replace all
   steps that are not `done` with them via `PlanTracker.revise`, keeping the
   `dependsOn` each new step declares, and continue scheduling.
3. WHEN `MAX_REPLANS` is reached or replanning fails, THE SYSTEM SHALL skip
   the remaining steps and go to synthesis, which states what was not done.
4. THE SYSTEM SHALL keep `dependsOn` on revised steps in both
   `PlanTracker.revise` and the `revise_plan` tool, instead of setting it to
   an empty list.

### Requirement 7: Synthesis

**User Story:** As a user, I want one coherent final answer, so that I don't
have to piece together worker outputs.

#### Acceptance Criteria

1. WHEN no step is pending or running, THE SYSTEM SHALL make one synthesis
   call that writes the final answer from the goal and all `WorkerResult`s,
   including failed and skipped steps.
2. THE SYSTEM SHALL stream the synthesis text as `text_delta` events and
   SHALL NOT stream worker text as `text_delta` events.
3. THE SYSTEM SHALL run the answer critic and the online judge on the
   synthesized answer, against the merged steps of all workers, as it does
   for single-agent runs.

### Requirement 8: Shared run budget

**User Story:** As an operator, I want a run's limits to hold no matter how
many workers it uses, so that orchestration cannot multiply cost.

#### Acceptance Criteria

1. THE SYSTEM SHALL keep one run ledger for tokens, cost and wall-clock time
   per run, with limits resolved as today (`RUN_*` env limits tightened by
   the request).
2. THE SYSTEM SHALL give each worker a child budget capped at
   `WORKER_BUDGET_SHARE` (default 0.5) of the run ledger's remaining tokens
   and cost when the worker starts.
3. THE SYSTEM SHALL charge every worker step to both its child budget and
   the run ledger.
4. WHEN the run ledger is exhausted, THE SYSTEM SHALL start no new workers,
   force the wrap-up step on running workers, and set the run's `stopReason`.
5. THE SYSTEM SHALL apply identical-call loop detection per worker.

### Requirement 9: Shared safety state

**User Story:** As an operator, I want approvals, the kill switch and the
Launch validation gate to work the same with workers as without them.

#### Acceptance Criteria

1. THE SYSTEM SHALL create one `LaunchValidationGate` per Launch run and
   pass the same instance to every worker.
2. THE SYSTEM SHALL keep the library handoff and publish transition as
   single final steps that start only after every generation step is `done`.
3. THE SYSTEM SHALL give each worker an `AbortController` that aborts when
   the run's controller aborts.
4. WHEN a run is cancelled or the kill switch trips, THE SYSTEM SHALL abort
   every running worker of that run and start no new ones.
5. THE SYSTEM SHALL gate worker tool calls with the same approval policy as
   single-agent runs, and SHALL allow several approvals of one run to be
   pending at once.
6. THE SYSTEM SHALL record `workerId` on every audit event from a worker.

### Requirement 10: Fallback per worker

**User Story:** As a user, I want a provider failure in one worker not to
restart my whole run.

#### Acceptance Criteria

1. WHEN a worker's model fails with a provider failure AND the worker has not
   executed a write or destructive tool call, THE SYSTEM SHALL restart only
   that worker on a same-tier fallback model.
2. WHEN a worker's model fails AND the worker has executed a write or
   destructive tool call, THE SYSTEM SHALL fail that worker's step instead of
   restarting it.
3. WHEN a worker restarts, THE SYSTEM SHALL emit a `restart` event with that
   worker's `workerId` and increment its `attempt`.

### Requirement 11: Stream events

**User Story:** As a UI developer, I want worker activity in the event stream,
so that the page can show what each worker is doing.

#### Acceptance Criteria

1. WHEN a worker starts, THE SYSTEM SHALL emit
   `{ type: 'worker_start', workerId, stepId, modelKey, tools }`.
2. WHEN a worker ends, THE SYSTEM SHALL emit
   `{ type: 'worker_done', workerId, status, result?, budgetUsage, error? }`.
3. THE SYSTEM SHALL set `workerId` on `step`, `approval_request` and
   `restart` events that come from a worker.
4. WHEN a client receives a `restart` event with a `workerId`, THE CLIENT
   SHALL discard only that worker's steps.
5. THE SYSTEM SHALL keep every existing event type and field unchanged for
   single-agent runs.

### Requirement 12: Run record and resume

**User Story:** As a user, I want orchestrated runs stored and resumable like
single-agent runs.

#### Acceptance Criteria

1. THE SYSTEM SHALL store `workers: WorkerRecord[]`, `orchestrated` and
   `replans` inside the existing `result` JSONB column of
   `harness_agent_runs`, with no table schema change.
2. THE SYSTEM SHALL checkpoint the run record after every worker step and
   every worker start and end.
3. THE SYSTEM SHALL bump `CHECKPOINT_SCHEMA_VERSION` to 2 and SHALL load
   version 1 records as single-agent runs.
4. WHEN an orchestrated run is resumed, THE SYSTEM SHALL keep `done` steps
   and their `WorkerResult`s and run only the steps that are not `done`.

### Requirement 13: Concurrency limits

**User Story:** As an operator, I want caps on concurrent work, so that one
instance is not overloaded and upstream rate limits are respected.

#### Acceptance Criteria

1. THE SYSTEM SHALL allow at most `MAX_AGENT_LOOPS` (default 12) agent loops
   to run at once across the process, counting workers and single-agent runs.
2. WHEN no loop slot is free, THE SYSTEM SHALL queue the worker until one is
   free, and SHALL release the slot when the loop ends, fails or is aborted.
3. WHEN `activeJobCount()` is at least `MAX_ACTIVE_RUNS` (default 6), THE
   SYSTEM SHALL reject `POST /api/build` with HTTP 429 and an error event
   with code `TOO_MANY_RUNS`.

### Requirement 14: Observability

**User Story:** As an operator, I want traces and metrics that show workers,
so that I can debug and compare orchestrated runs.

#### Acceptance Criteria

1. THE SYSTEM SHALL record a coordinator span under the run span and one
   child span per worker attempt, with `harness.worker.id`,
   `harness.worker.step_id` and `harness.worker.attempt` attributes.
2. THE SYSTEM SHALL report `orchestrated`, worker count, replans and
   per-worker token usage in the run record and on `/metrics`.

### Requirement 15: User interface

**User Story:** As a user, I want to see each worker's progress and approve
its calls.

#### Acceptance Criteria

1. THE SYSTEM SHALL group trace steps by `workerId` in `AgentTrace`, with one
   collapsible lane per worker showing status, model and tokens.
2. THE SYSTEM SHALL show several plan steps as `running` at once in
   `PlanView`, each linked to its worker lane.
3. THE SYSTEM SHALL list every pending approval of a run, each labelled with
   its worker and step.
4. THE SYSTEM SHALL render stored `workers` on `app/results/[id]`.

### Requirement 16: Evaluation

**User Story:** As a maintainer, I want evals that compare the two modes, so
that orchestration is turned on by default only when it helps.

#### Acceptance Criteria

1. THE SYSTEM SHALL make scripted eval tools answer by tool name and input,
   independent of call order.
2. WHEN `EVAL_ORCHESTRATE=both`, THE SYSTEM SHALL run each Launch eval
   fixture in both modes and report pass rate, wall-clock time, tokens and
   cost side by side.
3. THE SYSTEM SHALL keep separate baseline entries for orchestrated runs in
   `evals/baseline.json`, checked by `scripts/check-eval-baseline.mjs`.
4. THE SYSTEM SHALL include agent eval fixtures with independent steps and
   one with a forced worker failure.
