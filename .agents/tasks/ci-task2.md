# CI evidence — Task 2 (Planner support for parallel steps)

All commands run inside the worktree
`/Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers`
on branch `feat/orchestrator-workers`.

## What changed

Subtasks 2.1–2.4, all in the planner/launch-plan layer (no Next.js code, no
API routes touched).

- **2.1 — `lib/llm/planner.ts`**: `PlanTracker.revise` now keeps `dependsOn`
  per new step instead of setting it to `[]`. The revised plan is renumbered
  from 1 (kept `done` steps first, then the new steps in order); each new
  step's declared `dependsOn` is interpreted in that final numbering and
  filtered to existing earlier steps, dropping unknown, self and forward
  references. The `revise_plan` tool schema gains an optional
  `dependsOn: integer[]`. (Req 6.4)
- **2.2 — `lib/llm/planner.ts`**: `normalisePlan` now rejects malformed plans
  by throwing — a `dependsOn` id that was never declared, a self-dependency,
  or a dependency cycle (detected with a depth-first visit). A dependency on a
  step that existed but was trimmed by the `MAX_PLAN_STEPS` cap is still
  dropped, not rejected. The orchestration caller is expected to catch the
  throw and fall back to single-agent. (Req 3.6)
- **2.3 — `lib/llm/planner.ts`**: added `readySteps(plan)` (pending steps whose
  dependencies are all `done`) and `parallelWidth(plan)` (the largest set of
  mutually independent steps — the biggest antichain in the dependency DAG,
  computed exactly over the ≤ `MAX_PLAN_STEPS` steps). (Req 2.5, 3.3)
- **2.4 — `lib/llm/launch-plan.ts`**: the Launch seed template now carries an
  explicit `dependsOn` DAG instead of a strict chain. The two property reads
  (extensions, data elements) are independent; grounding depends on both reads;
  generation depends on grounding; validation depends on the reads and
  generation; library population depends on validation; and (when publishing)
  build depends on the populated library and the transition depends on the
  build. This gives the template a `parallelWidth` of 2 so orchestration can
  help. (Req 9.2)

Tests added/updated only where subtasks 2.1–2.4 specify:
`lib/llm/planner.test.ts` (revise keeps/remaps/drops `dependsOn`, `revise_plan`
schema, `normalisePlan` cycle/unknown-id/self rejection and cap-trim drop,
`readySteps`, `parallelWidth`) and `lib/llm/launch-plan.test.ts` (new backbone
DAG, parallel reads, publish ordering).

## CI gate — all pass

Re-verified on the committed Task 2 state (HEAD `feat/orchestrator-workers`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0, no warnings/errors) |
| `npm test` | PASS — 45 files, **495 passed** |
| `npm run build` | PASS — Next.js compiled, TypeScript checked, all routes built |

## How to reproduce

```
cd /Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers
npx tsc --noEmit -p . && npm run lint && npm test && npm run build
```

No review rejection file (`.agents/tasks/review-task2.md`) was present, so
there were no prior-iteration findings to address.
