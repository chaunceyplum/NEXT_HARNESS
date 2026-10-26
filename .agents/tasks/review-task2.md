# Planner support for parallel steps (Task 2)

Task 2 teaches the planner layer about dependencies so a later coordinator can run independent steps at once. `PlanTracker.revise` and the `revise_plan` tool schema now carry `dependsOn` through a renumbering instead of flattening it to `[]`; `normalisePlan` now rejects malformed DAGs (unknown ids, self-edges, cycles) while still tolerating cap-trimmed references; two new pure functions, `readySteps` and `parallelWidth`, expose the DAG to the scheduler; and the Launch seed template trades its strict chain for a real DAG whose two property reads are independent. The change is confined to `lib/llm/planner.ts` and `lib/llm/launch-plan.ts` plus their tests — no API routes, no Next.js code, no agent loop. CI evidence reports all four gates green (tsc, lint, 495 tests, build).

Watch for: a forward dependency that is not part of a cycle survives `normalisePlan` where the old code dropped it (confirmed, likely benign); `normalisePlan`'s cap-drop-vs-reject decision depends on `dependsOn` ids being unique across the raw plan (confirmed, low risk). Both are noted below; neither blocks the task.

**Verdict**: APPROVED

## High-level view

The dependency contract is now carried end to end instead of being discarded. `revise` renumbers kept-done steps first and new steps after them, interprets each new step's declared `dependsOn` in that final numbering, and drops anything that would point at a missing, self, or forward step — so a revised plan is always acyclic by construction. The `revise_plan` schema gained an optional `dependsOn` so the model can actually express this, and omitting it preserves today's empty-dependency behaviour.

`normalisePlan` moved from "silently drop dangling deps" to "drop only what the cap trimmed, reject everything else." Unknown ids, self-edges, and cycles throw; the spec's intent (Req 3.6) is that the orchestration caller catches the throw and falls back to single-agent, so the throw is the contract, not a crash. That caller does not exist yet in this task, which is expected — the rejection surface is what Task 2 owes.

`readySteps` and `parallelWidth` are the scheduler's read model. `readySteps` returns pending steps whose dependencies are all `done`; `parallelWidth` returns the largest antichain in the DAG, computed by an exact subset scan that is only affordable because plans are capped at eight steps. `shouldOrchestrate` (a later task) will use the width to decide whether orchestration can help, matching Req 2.5.

The Launch template now encodes the genuine structure of a Launch build: the two reads are independent (width 2), grounding joins them, and generation, validation, library population, build, and transition stay ordered behind. This is the concrete payload that makes orchestration worthwhile for the default workload (Req 9.2).

<details>
<summary>Issues (3)</summary>

1. **Forward-reference survival** — a non-cyclic forward edge (step 1 dependsOn step 3) is no longer dropped by `normalisePlan` as it was pre-change; it is a valid DAG edge so `readySteps` just makes step 1 wait, but confirm the scheduler treats "pending step with a later-numbered dependency" as waiting rather than ready. Add a test if that ordering matters.
2. **Duplicate raw ids** — the cap-trim-vs-reject branch keys off `raw.steps.some((o) => o.id === d)` and a `Map` built from original ids; if the model emits duplicate step ids the mapping is ambiguous. Pre-existing schema gap, worth a guard when the orchestration caller lands.
3. **`parallelWidth` cost** — exact O(2^n) antichain scan is safe only because `MAX_PLAN_STEPS` is 8; if that cap ever rises this becomes a hot spot. Leave a note at the cap constant.

</details>

<details>
<summary>Details</summary>

### Dependency carried through `revise` and the tool schema

The old `revise` set every new step's `dependsOn` to `[]`, which Req 6.4 calls out as the thing to stop doing. The new version computes `selfId = kept.length + i + 1` and keeps only declared ids in `[1, total]` strictly less than `selfId` — one filter that drops missing (above `total`), self, and forward references in a single pass. Because every surviving edge points strictly backward, the revised plan cannot contain a cycle, so the revise path needs no separate cycle check. Tests confirm the remap, the drop of a nonexistent `[7]`, and the omitted-`dependsOn` default to `[]`.

`revise_plan` omits `dependsOn` from `required`, so an older model that never sends it still produces today's empty-dependency plan — the backward-compatible default the single-agent path depends on.

### `normalisePlan`: reject malformed, tolerate cap-trimmed

An id absent from `idMap` but present in `raw.steps` was cap-trimmed and is dropped; an id absent from both throws `unknown step`; a resolved id equal to the current step throws `depends on itself`; and `assertAcyclic` throws on a back edge. Tests cover unknown-id, cycle, self, and cap-trim-drop, matching Req 3.6's "reject cycles and unknown ids."

One asymmetry with the pre-change code: the old remap filtered with `d < i + 1`, silently dropping any dependency on a later step. The new code keeps a forward edge (e.g. step 1 declaring `dependsOn: [3]`) as long as it does not close a cycle. That is legal DAG semantics — `readySteps` holds step 1 until step 3 is `done` — but it is a genuine change from "forward deps vanish" to "forward deps are honoured." Worth a scheduler-side test that a pending step with a not-yet-done later dependency is not treated as ready.

The cap-trim branch relies on `raw.steps.some((o) => o.id === d)` to distinguish "declared but trimmed" from "never declared," while the renumbering map is keyed on the original ids of the post-cap slice. If the model ever emits duplicate ids, both the map and this membership test become ambiguous. The planner schema does not enforce id uniqueness, so this is a pre-existing gap rather than a regression, but the orchestration caller that catches these throws should be aware a duplicate-id plan could remap in a surprising way rather than throw.

### `readySteps` and `parallelWidth`

`readySteps` returns pending steps whose every dependency is in the `done` set — the glossary/Req 2.5/3.3 definition. Steps in `running`, `failed`, or `skipped` are not ready; both the single-ready and several-independent cases are tested.

`parallelWidth` computes the maximum antichain via an exact subset scan. It is exponential, but `MAX_PLAN_STEPS` caps the input at eight (worst case 256 subsets). If that cap ever rises, this becomes a hot spot — leave a note at the constant. The reachability cache is seeded before recursion so a cycle cannot cause infinite recursion even though `normalisePlan` already rejects cycles. Tests pin width 1 for the serial plan and width 2 for the diamond.

### Launch template DAG (Req 9.2)

`seedLaunchPlan` now forwards `s.dependsOn` instead of the previous `i === 0 ? [] : [i]` chain. The encoded structure — reads `[], []`; ground `[1,2]`; generate `[3]`; validate `[1,2,4]`; populate `[5]`; and when publishing, build `[6]`, transition `[7]` — gives the template a `parallelWidth` of exactly 2, the minimum that makes orchestration meaningful. Validate depends on both reads and the generation (`[1,2,4]`) because it re-checks the generated set against live extension/data-element state, so the extra edges are real. Tests assert the full `dependsOn` vector, the width, and the publish ordering.

</details>

<details>
<summary>File map</summary>

- `lib/llm/planner.ts` — `revise` + `revise_plan` schema carry `dependsOn`; `normalisePlan` rejects malformed DAGs; new `readySteps`, `parallelWidth`, `assertAcyclic`.
- `lib/llm/launch-plan.ts` — `SeedStep.dependsOn` added; seed template emits a real DAG instead of a strict chain.
- `lib/llm/planner.test.ts` — remap/drop/reject cases, `readySteps`, `parallelWidth`, `revise_plan` optional `dependsOn`.
- `lib/llm/launch-plan.test.ts` — backbone DAG vector, parallel reads, publish ordering.
- `.agents/tasks/ci-task2.md`, `.kiro/specs/orchestrator-workers/tasks.md` — CI evidence and checkbox updates.

Full diff: `git diff HEAD~1` on `feat/orchestrator-workers`.

</details>
