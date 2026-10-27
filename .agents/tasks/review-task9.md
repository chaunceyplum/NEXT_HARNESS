# Worker lanes in the orchestrated-run UI (Task 9)

The commit wires the orchestrator's worker model into the four client surfaces that were still single-agent: the live home page, the shared `AgentTrace`, the `PlanView` status badges, and the stored-run results page. It adds a `WorkerLane` view type, handles the `worker_start` / `worker_done` / per-worker `restart` stream events, keeps several pending approvals at once (one per worker), groups trace steps into collapsible per-worker lanes with coordinator/synthesis steps on top, links plan-step badges to their worker lanes by anchor, and reconstructs the same lane layout from stored `WorkerRecord`s on the results page. Single-agent runs keep the flat trace unchanged because the `workers` prop is left undefined. This is UI-only rendering built on the types and events already landed in Tasks 7 and 8, and the diff stays within the four files named by the spec.

Watch for: (1) the live `worker_done` handler does not carry the final `attempt` onto the lane, so a worker that ran a fallback shows no "attempt N" badge after it finishes live — cosmetic, **confirmed**; (2) no new automated tests — coverage rests entirely on tsc/lint/build per the CI note, **confirmed**. Both are minor; the behavioral contracts against the event and record types all check out.

**Verdict**: APPROVED

## High-level view

The trace rendering is refactored so one `StepCard` component backs both the flat single-agent list and the per-lane step lists, and a sibling `WorkerLaneCard` renders each worker as a collapsible section keyed and anchored by `workerId`. The branch is driven purely by whether a non-empty `workers` prop is passed, which keeps single-agent output byte-identical.

Lane population depends on each trace step carrying a `workerId`. That tag is set server-side on the `AgentStepDTO` itself (build-run's `onStep` merges `workerId` into the redacted step before emitting), so the client can push `event.step` unchanged and still filter steps into lanes by `s.workerId === lane.workerId`. The same tagging lets the per-worker `restart` handler drop only the abandoned worker's steps while the others survive.

The results page rebuilds the identical lane layout from stored data: lanes come from `WorkerRecord`s, and steps are merged as coordinator steps (no `workerId`) from `result.steps` plus each worker's own recorded steps re-tagged with its `workerId`. Taking worker steps from the records rather than trusting `result.steps` to carry them is the safer source and keeps lanes populated regardless of how the stored steps were merged. The orchestrated layout only engages when both `result.orchestrated` and a non-empty `workers` array are present, so legacy single-agent records render as before.

Approvals move from a single pending card to a list, each tagged with its originating `workerId` and linking to that worker's lane. Plan-step badges likewise become anchor links to `#worker-<id>` when the step has a worker, allowing several concurrent `running` steps to coexist and each to jump to its lane.

<details>
<summary>Issues (2)</summary>

1. **Live attempt badge missing after fallback** — `worker_done` updates status/budget/error but not `attempt`, so a worker that restarted shows no "attempt N" once it completes in a live run (the badge does appear on the results page, which reads `attempt` from the record). Carry `attempt` on `worker_done`, or accept the live/stored asymmetry as cosmetic.
2. **No automated tests for the UI change** — lane grouping, the restart-by-worker filter, and the results-page merge are exercised only by tsc/lint/build. A render test over `AgentTrace` with a mixed coordinator+worker step set and a `mergeWorkerSteps` unit test would lock the grouping behavior.

</details>

<details>
<summary>Details</summary>

### Lane grouping hinges on server-tagged step workerIds

`AgentTrace` splits its input with `steps.filter((s) => !s.workerId)` for the top coordinator/synthesis block and `steps.filter((s) => s.workerId === lane.workerId)` for each lane. Both the live and stored paths feed it steps whose `workerId` lives on the `AgentStepDTO`, not on an envelope. On the live path the home page pushes `event.step` into `steps` untouched; that is correct because build-run's `onStep` already does `{ ...redactOutput(step), ...(workerId ? { workerId } : {}) }` before emitting, so the DTO carries the tag. The event-envelope `workerId` on the `step` event is redundant for the client and is ignored — not a bug, but worth knowing that the lane filter would silently show empty lanes if a future emitter ever stopped tagging the DTO and relied only on the envelope.

### Per-worker restart matches the server's definition of the abandoned attempt

The `restart` handler branches on `event.workerId`: with one it keeps the trace and removes just that worker's steps (`steps.filter((s) => s.workerId !== event.workerId)`), bumps the lane's `attempt`, and resets its status to `running`; without one it clears all steps and streamed text. This mirrors build-run's `onRestart`, which splices the same worker's steps out of its own `steps` array server-side, so a live fallback and a checkpoint reload drop the same steps.

### Live vs stored attempt asymmetry

The lane's `attempt` is set two ways. On `restart` the client bumps `(w.attempt ?? 1) + 1`; on `worker_done` it merges only `status`, `budgetUsage`, and `error`, not `attempt`. Because the restart event always precedes the fallback's `worker_done` and that handler leaves `attempt` untouched, the bumped value survives — the badge is only absent if a fallback's `worker_done` ever arrives without a preceding client-side `restart`. Practical impact is cosmetic, and the stored path reads `attempt` straight off the `WorkerRecord`, so results pages are unaffected.

### Results-page reconstruction takes worker steps from the records

`mergeWorkerSteps` builds the trace from coordinator steps (`result.steps` with no `workerId`) plus `workers.flatMap((w) => w.steps.map((s) => ({ ...s, workerId: s.workerId ?? w.workerId })))`. Sourcing worker steps from the `WorkerRecord`s instead of `result.steps` means lane population does not depend on how the stored merged `result.steps` was assembled, and the `s.workerId ?? w.workerId` fallback tolerates records whose steps were stored without the tag. The orchestrated layout is gated on `Boolean(record.result.orchestrated) && workers.length > 0`, so a version-1 single-agent record (no `orchestrated`, no `workers`) renders through the unchanged flat path.

### Approvals and plan badges support concurrency

Pending approvals became a list appended per `approval_request`, each entry carrying the event's optional `workerId`; the card renders a dotted `#worker-<id>` link and, via `workerStepId`, a "step N" hint parsed from the `${runId}:w${stepId}:${attempt}` id. The regex `/:w(\d+):(\d+)$/` is anchored to the end and degrades gracefully (no link suffix) if the id shape ever changes, so a parse miss cannot throw. `PlanView` turns the status badge into an anchor only when `s.workerId` is set, leaving single-agent plans with plain spans; several `running` steps can now coexist because nothing forces a single active step.

### Test coverage

No tests were added. The CI note states the change is UI rendering only and leans on `tsc --noEmit`, `lint`, and the production `build` (545 tests still green, 15/15 pages). That covers type contracts and compile integrity but not behavior: the coordinator-vs-worker step split, the restart-by-worker filter, and `mergeWorkerSteps` are untested. These are pure functions over typed inputs and are the kind of thing a small render/unit test would pin down cheaply. Not a blocker for a UI pass, but the first place to add coverage if lane grouping regresses.

### Scope

The four changed source files are exactly those named in tasks 9.1–9.4; the only other edits are `tasks.md` checkboxes and the CI evidence note. No unrelated changes are bundled in.

</details>

<details>
<summary>Files changed</summary>

- `app/page.tsx` — `workers` lane map in run state; `worker_start` / `worker_done` / per-worker `restart` handlers; pending-approvals list tagged with `workerId`; `workerStepId` parser; approval card worker link.
- `components/AgentTrace.tsx` — `WorkerLane` type export; extracted `StepCard`; new `WorkerLaneCard`; branch rendering coordinator steps + lanes vs flat list.
- `components/PlanView.tsx` — status badge becomes a `#worker-<id>` anchor when the step has a worker.
- `app/results/[id]/page.tsx` — `buildWorkerLanes` and `mergeWorkerSteps`; orchestrated gate; pass reconstructed lanes to `AgentTrace`.
- `.kiro/specs/orchestrator-workers/tasks.md` — task 9 checkboxes.
- `.agents/tasks/ci-task9.md` — CI evidence (new).

Full diff: `git show HEAD` on `feat/orchestrator-workers`.

</details>
