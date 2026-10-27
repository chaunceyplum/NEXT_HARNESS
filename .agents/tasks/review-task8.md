# Orchestration types, worker events, record and resume (Task 8)

Task 8 carries the orchestrator-worker feature from internal plumbing to the edges of the system: the shared type home, the HTTP request surface, the stream event vocabulary, the checkpoint/record format, and the resume path. `WorkerStatus` / `WorkerResult` / `WorkerRecord` move to `lib/types.ts` and are re-exported from `worker.ts` for existing importers; `workerId` threads through step, restart and audit events; `/api/build` accepts and validates `orchestrate` and `maxWorkers`; `build-run.ts` forwards `worker_start` / `worker_done`, tags events with `workerId`, drops only the restarted worker's steps on a same-tier fallback, and checkpoints workers mid-run; the checkpoint schema bumps to 2 with v1 records read back as single-agent; `resumeContextFrom` reconstructs an orchestrated run from its done steps and their worker results; and `/api/metrics` grows an orchestration rollup. The approach keeps all orchestration data inside the existing `result` JSONB, so no `harness_agent_runs` DDL is needed and single-agent record shape is unchanged.

Watch for: a documented approval-gate gap where worker `approval_request` events never carry `workerId` (confirmed, behaviour-safe, deferred); and the v1→single-agent normalization (Requirement 12.3) ships without an automated test (confirmed, low production risk).

**Verdict**: APPROVED

## High-level view

The type re-home is a clean single-source move. The definitions land in `lib/types.ts`, `worker.ts` re-exports them, and `WorkerRecord.steps` is typed `AgentStepDTO[]` which is structurally identical to the `AgentStepTrace` the runtime produces, so the runtime assignment holds without a cast. No importer breaks.

The request surface validates `orchestrate` as a strict boolean and `maxWorkers` as an integer in 1–16, rejecting non-booleans, zero, fractions and out-of-range values with 400s before anything reaches the coordinator. Both are forwarded only when well-typed. The env flag still gates whether orchestration actually runs; the route only checks shape.

Event and checkpoint handling is where the behavioral weight sits. `build-run.ts` opens a worker lane on `worker_start`, records each finished worker keyed by `workerId` (so a retried attempt replaces the earlier record), and on a per-worker restart removes only that worker's steps from the checkpoint rather than the whole trace. Single-agent restarts still clear everything, so the two paths stay distinct. Mid-run checkpoints now carry the orchestration fields so an interrupted orchestrated run resumes with its finished workers.

The checkpoint schema bump to 2 is handled read-side: a result stored under v1 (or with no version) is normalized to single-agent, stripping any stray orchestration fields so an old record can never be mistaken for an orchestrated one. This back-compat guarantee has no automated test.

Resume reconstructs context from the plan's done steps plus the latest `WorkerResult` per step, carrying the summary and ids forward and listing the steps still to do, with an instruction not to redo completed work. The orchestrated branch is taken only when `result.orchestrated && result.plan`; everything else falls through to the existing tool-call history path.

Metrics add an orchestration rollup (orchestrated run count and rate, total/mean workers, replans, tokens-per-worker) backed by additive, COALESCE-guarded SQL on the `result` JSONB, so non-orchestrated rows read as null and collapse to undefined.

The one deliberately deferred item: worker `approval_request` events carry an optional `workerId` in the type, but the shared approval gate is built once in `prepareRun` before any worker exists and is not threaded the per-call worker id, so worker approvals leave `workerId` unset. Approvals still function; only the lane attribution is missing. Audit entries from workers do carry `workerId` via the `onToolOutcome` path.

<details>
<summary>Issues (2)</summary>

1. **Approval-request workerId unset** — worker `approval_request` events never populate `workerId` because the approval gate predates the workers; behaviour-safe and documented, thread the id through the gate in a later task if the UI needs lane attribution.
2. **v1 back-compat untested** — `normaliseResult` strips orchestration fields from v1 records (Requirement 12.3) but has no test and no `execution-store.test.ts`; low production risk since real v1 records don't carry those fields, but the back-compat guarantee is unverified.

</details>

<details>
<summary>Details</summary>

### Type re-home without a cast

The three worker types move to `lib/types.ts` and `worker.ts` switches to `export type { WorkerStatus, WorkerResult, WorkerRecord } from '../types'` plus a local `import type`. The risk in a move like this is the record's `steps` field: it was `AgentStepTrace[]` in the old local definition and is `AgentStepDTO[]` in the new home. The two are structurally identical, so the coordinator's runtime records (which build `AgentStepTrace[]`) assign into `WorkerRecord` without a cast, and `tsc --noEmit` passing confirms no importer broke. `budgetUsage` is typed inline as `{ tokens; costUsd?; durationMs }` in the new home rather than importing `BudgetUsage` from `run-budget`, which keeps `lib/types.ts` free of an LLM-layer dependency.

### Request validation is strict and fail-closed

`maxWorkers` is checked with `Number.isInteger` and a 1–16 range, so `0`, `2.5` and `99` are all rejected (the test asserts each), and `orchestrate` must be a literal boolean, rejecting `'yes'`. Only well-typed values are forwarded (`typeof b.orchestrate === 'boolean'` / `=== 'number'`), so a malformed field can't slip through as `undefined`-but-truthy.

### Per-worker restart drops only one lane

```
onRestart: ({ fromModelKey, toModelKey, workerId }) => {
  if (workerId) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].workerId === workerId) steps.splice(i, 1);
    }
  } else {
    steps.length = 0;
  }
  push({ type: 'restart', ... });
  checkpoint();
}
```

This is the central behavioral change and it correctly distinguishes the two failure modes: an orchestrated worker's same-tier fallback discards only that worker's abandoned steps, while a single-agent restart still clears the whole trace. The route test drives two workers, restarts one, and asserts the running checkpoint keeps 2 steps (w2's surviving step + w1's re-run step) rather than 3 — confirming the other lane's steps survive. The added `checkpoint()` after a restart means the discard is persisted immediately, not left to the next step.

### Resume from done steps

`orchestratedResumeContext` builds a latest-result-per-step map (a later attempt supersedes an earlier one), emits each done step with its summary and ids, and lists not-done steps as still-to-do, under a "do not redo these / reuse the ids above" instruction. The branch is entered only when `result.orchestrated && result.plan`, so single-agent and v1 records fall through to the unchanged tool-call history path. The done-lines block is truncated to `MAX_RESUME_CHARS`. The test exercises a two-done / one-pending plan and asserts the ids are carried and step 3 is listed as remaining.

### Checkpoint v2 and v1 normalization

`CHECKPOINT_SCHEMA_VERSION` goes to 2 and `normaliseResult` reads version-aware: v2+ results pass through untouched, while a v1 (or version-absent) result that somehow carries `orchestrated` / `replans` / `workers` has them stripped so it is never read as orchestrated. Orchestration data lives inside the existing `result` column, so there is no table migration. The gap: this normalization has no unit test and there is no `execution-store.test.ts` at all. The guarantee is a defensive safety net — real v1 records won't carry orchestration fields — so the production risk is low, but the back-compat path is unverified by CI.

### Metrics rollup

`computeOrchestration` filters orchestrated rows and derives counts, rate, total/mean workers, replans and a rough tokens-per-worker (run chat tokens / workers). The SQL additions are additive and COALESCE-guarded: `jsonb_array_length(COALESCE(r.result->'workers', '[]'))` is zero rather than null for runs without workers, and `(r.result->>'orchestrated')::boolean` / `::int replans` read as null for old rows and collapse to `undefined` via `?? undefined` / `num()`. Non-orchestrated rows therefore contribute nothing to the rollup, and `orchestratedRate` guards division by `rows.length`.

### Audit workerId

A nullable `worker_id TEXT` column is added both in the `CREATE TABLE` and via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for pre-existing tables — additive and idempotent (Requirement 9.6). The insert column list and `valuesRow` both include it, and `listAudit` maps `worker_id` back to `workerId`. Worker tool outcomes reach this via the `onToolOutcome(o, workerId)` path the coordinator tags.

### Approval-request attribution gap

The `approval_request` event type gains an optional `workerId`, but nothing populates it for worker calls: the approval gate is constructed once in `prepareRun` before any worker exists, and the per-call worker id is not threaded to it. Worker approvals still work; they just can't be filed under a lane in the UI. Audit entries from the same worker calls do carry `workerId`. This is documented in the CI notes and is outside the Task 8.3 requirement set (9.6, 11.1–11.3, 11.5, 12.2), so it is an acceptable deferral rather than a miss.

</details>

<details>
<summary>File map</summary>

- `lib/types.ts` — new `WorkerStatus` / `WorkerResult` / `WorkerRecord`; `workerId?` on `AgentStepDTO` and `PlanInfo` steps; `orchestrate?` / `maxWorkers?` on `BuildRequest`; `orchestrated?` / `replans?` / `workers?` on `BuildResponse`; `worker_start` / `worker_done` stream events and `workerId?` on `step` / `restart` / `approval_request`.
- `app/api/build/route.ts` — validate `orchestrate` (boolean) and `maxWorkers` (int 1–16); forward both.
- `app/api/build/route.test.ts` — orchestration input-validation 400s; end-to-end worker-event / per-worker-restart / record-storage streaming test.
- `lib/build-run.ts` — forward worker events, tag step/restart/audit with `workerId`, per-worker restart discard, mid-run worker checkpoints, orchestration fields in final record, `orchestratedResumeContext`.
- `lib/build-run.test.ts` — orchestrated resume-from-done-steps test.
- `lib/execution-store.ts` — `CHECKPOINT_SCHEMA_VERSION` → 2; `normaliseResult` v1→single-agent.
- `lib/llm/agent.ts` — `workerId?` on `onStep` / `onRestart` / `onToolOutcome`; new `onWorkerStart`; forwarding into `runOrchestrated`.
- `lib/llm/coordinator.ts` — `onWorkerStart` with narrowed tool names; worker-tagged `onStep` / `onToolOutcome`.
- `lib/llm/worker.ts` — re-export worker types from `lib/types.ts`.
- `lib/audit-log.ts` — nullable `worker_id` column (create + idempotent alter), insert and read mapping.
- `lib/production-metrics.ts` — `OrchestrationMetrics`, `computeOrchestration`, SQL columns for orchestrated/worker_count/replans.
- `.kiro/specs/orchestrator-workers/tasks.md` — Task 8 subtasks checked off.
- `.agents/tasks/ci-task8.md` — CI evidence (added this commit).

Full diff: `git diff f1976a6 HEAD` in the worktree.

</details>
