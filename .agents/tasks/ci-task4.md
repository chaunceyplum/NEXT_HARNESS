# CI Gate — Task 4 (Shared run budget)

Branch: `feat/orchestrator-workers`
Worktree: `/Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers`

All four CI commands were run inside the worktree and all passed before committing.

## 1. `npx tsc --noEmit -p .`

```
(no output)
Exit Code: 0
```

## 2. `npm run lint`

```
> harness@0.1.0 lint
> eslint

Exit Code: 0
```

## 3. `npm test`

```
> harness@0.1.0 test
> vitest run
 RUN  v4.1.11 /Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers
 Test Files  46 passed (46)
      Tests  511 passed (511)
   Duration  4.82s

Exit Code: 0
```

Targeted run of the task's test file (`lib/llm/run-budget.test.ts`):

```
 Test Files  1 passed (1)
      Tests  16 passed (16)

Exit Code: 0
```

## 4. `npm run build`

```
✓ Compiled successfully in 870ms
  Running TypeScript ...
  Finished TypeScript in 4.4s ...
  Collecting page data using 7 workers ...
✓ Generating static pages using 7 workers (15/15) in 249ms
  Finalizing page optimization ...
(route table rendered)

Exit Code: 0
```

## What was implemented

Subtask 4.1 — `lib/llm/run-budget.ts`:

- Added a `RunLedger` class holding the run's resolved limits and accumulating
  tokens, cost and wall-clock time across every worker.
- `RunLedger.child(modelKey, share)` returns a `RunBudgetTracker` whose own
  limits are capped at `share` of the ledger's remaining tokens and cost at the
  moment the worker starts, sharing the run clock (req 8.2).
- `RunBudgetTracker` gained an optional `parent` (the ledger). `recordStep`
  charges both the child and the ledger (req 8.3), and `exceeded()` reports the
  child's own reason or the ledger's exhaustion reason (req 8.1).
- Identical-call loop detection stays per worker on the child tracker (req 8.5).
- The single-agent path still constructs `RunBudgetTracker` with no parent, so
  its behaviour is unchanged.

Tests added to `lib/llm/run-budget.test.ts` covering child slice capping,
dual charging, ledger exhaustion reported to a worker, cost/time exhaustion,
per-worker loop detection, and the unchanged no-parent path (reqs 8.1, 8.2,
8.3, 8.5).
