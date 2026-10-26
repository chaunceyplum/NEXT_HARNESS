# Planner support for parallel steps (Task 2)

Task 2 teaches the planner layer about dependencies so a later coordinator can run independent steps at once. `PlanTracker.revise` and the `revise_plan` tool schema now carry `dependsOn` through a renumbering instead of flattening it to `[]`; `normalisePlan` rejects malformed DAGs (unknown ids, self-edges, cycles) while still tolerating cap-trimmed references; two new pure functions, `readySteps` and `parallelWidth`, expose the DAG to the scheduler; and the Launch seed template trades its strict chain for a real DAG whose two property reads are independent. The change is confined to `lib/llm/planner.ts` and `lib/llm/launch-plan.ts` plus their tests — no API routes, no Next.js code, no agent loop. CI evidence (`ci-task2.md`) reports all four gates green: tsc, lint, 495 tests, build.

Watch for: a non-cyclic forward dependency now survives `normalisePlan` where the pre-change code dropped it (confirmed, benign under DAG semantics but a behaviour change); `revise` keeps `done` steps at their original ids and only the new steps are renumbered, so its `dependsOn` filter (`d <= total`) assumes `done` ids form a contiguous `1..kept.length` prefix (confirmed, latent, surfaces only when the future coordinator feeds it non-contiguous done ids). Neither blocks the task.

**Verdict**: APPROVED

## High-level view

The dependency contract is now carried end to end instead of discarded. `revise` renumbers kept-done steps first and new steps after them, interprets each new step's declared `dependsOn` in that final numbering, and drops anything pointing at a missing, self, or forward step — so a revised plan is acyclic by construction and needs no separate cycle check. The `revise_plan` schema gained an optional `dependsOn`, and omitting it preserves today's empty-dependency behaviour, which the single-agent path relies on.

`normalisePlan` moved from "silently drop dangling deps" to "drop only what the cap trimmed, reject everything else." Unknown ids, self-edges, and cycles throw. Req 3.6's intent is that the orchestration caller catches the throw and falls back to single-agent, so the throw is the contract, not a crash. That caller is a later task, which is expected; the rejection surface is what Task 2 owes.

`readySteps` and `parallelWidth` are the scheduler's read model. `readySteps` returns pending steps whose dependencies are all `done`; `parallelWidth` returns the largest antichain in the DAG via an exact subset scan, affordable only because `MAX_PLAN_STEPS` caps plans at eight. The prior review's note about that cost is now addressed with an explicit comment at the constant warning that a higher cap needs a polynomial algorithm.

The Launch template now encodes the genuine structure of a Launch build: the two reads are independent (width 2), grounding joins them, and generation, validation, library population, build, and transition stay ordered behind. This is the concrete payload that makes orchestration worthwhile for the default workload (Req 9.2).

<details>
<summary>Issues (3)</summary>

1. **Forward-reference survival** — a non-cyclic forward edge (step 1 `dependsOn` step 3) is no longer dropped by `normalisePlan` as it was pre-change; it is a valid DAG edge so `readySteps` just makes step 1 wait. Confirm the future scheduler treats "pending step with a later-numbered dependency" as waiting, not ready, and add a test when that caller lands.
2. **Non-contiguous done ids in `revise`** — kept `done` steps retain their original ids while new steps renumber from `kept.length + 1`; the dependency filter `d <= total` assumes done ids are a `1..kept.length` prefix. This holds in current single-agent flows but could mis-map if the coordinator ever revises a plan whose done ids are non-contiguous. Add a guard or renumber kept steps when the coordinator lands.
3. **`parallelWidth` cost** — exact O(2^n) antichain scan is safe only because `MAX_PLAN_STEPS` is 8. Already noted with a comment at the constant; keep that note in sync if the cap ever rises.

</details>

<details>
<summary>Details</summary>

### Dependency carried through `revise` and the tool schema

The old `revise` set every new step's `dependsOn` to `[]`, which Req 6.4 calls out as the thing to stop doing. The new version computes `selfId = kept.length + i + 1` and keeps only declared ids in `[1, total]` strictly less than `selfId` — one filter that drops missing, self, and forward references in a single pass, de-duplicated through a `Set`. Because every surviving edge points strictly backward, the revised plan cannot contain a cycle, so the revise path needs no separate cycle check. Tests confirm the remap (`[1]`, `[2,1]`), the drop of a nonexistent `[7]`, and the omitted-`dependsOn` default to `[]`.

One structural assumption rides underneath: `revise` keeps `done` steps verbatim (`filter((s) => s.status === 'done')`) without renumbering them, and only the new steps renumber from `kept.length + 1`. The `d <= total` bound therefore assumes the kept done ids occupy `1..kept.length`. In the current single-agent flow steps are executed roughly in order so this holds, and it is unchanged from the pre-Task-2 code, so it is not a regression. But the coordinator this task is built for could complete steps out of order and hand `revise` a plan whose done ids are non-contiguous; the filter would then admit or reject the wrong edges. Worth a guard or a renumber-kept-steps pass when that caller lands.

`revise_plan` omits `dependsOn` from `required`, so an older model that never sends it still produces today's empty-dependency plan — the backward-compatible default the single-agent path depends on.

### `normalisePlan`: reject malformed, tolerate cap-trimmed

The id resolution now distinguishes three cases cleanly: an id absent from `idMap` but present in `raw.steps` was cap-trimmed and is dropped; an id absent from both throws `unknown step`; a resolved id equal to the current step throws `depends on itself`; and `assertAcyclic` throws on a back edge via a three-colour DFS. Tests cover unknown-id, cycle, self, and cap-trim-drop, matching Req 3.6's "reject cycles and unknown ids."

One asymmetry with the pre-change code: the old remap filtered with `d < i + 1`, silently dropping any dependency on a later step. The new code keeps a forward edge (step 1 declaring `dependsOn: [3]`) as long as it does not close a cycle. That is legal DAG semantics — `readySteps` holds step 1 until step 3 is `done` — but it is a genuine change from "forward deps vanish" to "forward deps are honoured." Worth a scheduler-side test, when that caller exists, that a pending step with a not-yet-done later dependency is not treated as ready.

### `readySteps` and `parallelWidth`

`readySteps` returns pending steps whose every dependency is in the `done` set — the glossary/Req 2.5/3.3 definition. Steps in `running`, `failed`, or `skipped` are not ready; both the single-ready and several-independent cases are tested.

`parallelWidth` computes the maximum antichain via an exact subset scan. It is exponential, but `MAX_PLAN_STEPS` caps the input at eight (worst case 256 subsets). The reachability map is seeded before recursion so a cycle cannot cause infinite recursion even though `normalisePlan` already rejects cycles. The prior review asked for a note at the cap; this commit adds exactly that — a block comment at `MAX_PLAN_STEPS` warning that a higher cap turns this into a hot spot needing a polynomial max-antichain algorithm. Tests pin width 1 for the serial plan and width 2 for the diamond.

### Launch template DAG (Req 9.2)

`seedLaunchPlan` now forwards `s.dependsOn` instead of the previous `i === 0 ? [] : [i]` chain, with `SeedStep` gaining an explicit `dependsOn` field. The encoded structure — reads `[], []`; ground `[1,2]`; generate `[3]`; validate `[1,2,4]`; populate `[5]`; and when publishing, build `[6]`, transition `[7]` — gives the template a `parallelWidth` of exactly 2, the minimum that makes orchestration meaningful. Validate depends on both reads and the generation (`[1,2,4]`) because it re-checks the generated set against live extension/data-element state, so the extra edges are real. Tests assert the full `dependsOn` vector, the width, and the publish ordering.

</details>

<details>
<summary>File map</summary>

- `lib/llm/planner.ts` — `revise` + `revise_plan` schema carry `dependsOn`; `normalisePlan` rejects malformed DAGs; new `readySteps`, `parallelWidth`, `assertAcyclic`; cost note at `MAX_PLAN_STEPS`.
- `lib/llm/launch-plan.ts` — `SeedStep.dependsOn` added; seed template emits a real DAG instead of a strict chain.
- `lib/llm/planner.test.ts` — remap/drop/reject cases, `readySteps`, `parallelWidth`, `revise_plan` optional `dependsOn`.
- `lib/llm/launch-plan.test.ts` — backbone DAG vector, parallel reads, publish ordering.
- `.agents/tasks/ci-task2.md`, `.kiro/specs/orchestrator-workers/tasks.md` — CI evidence and 2.1–2.4 checkbox updates.

Full diff: `git diff main` on `feat/orchestrator-workers`.

</details>
