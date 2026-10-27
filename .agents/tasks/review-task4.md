# Shared run budget: RunLedger and parent charging on RunBudgetTracker

Task 4.1 adds a run-level `RunLedger` that every worker charges in addition to its own per-worker budget, so a run's token/cost/time limits hold no matter how many workers it spawns. Each worker receives a child `RunBudgetTracker` sized at a share of the ledger's remaining tokens and cost at the moment it starts, and `exceeded()` now reports the ledger's exhaustion reason even when the child's own slice has room. Loop detection stays per worker, and the single-agent path keeps building a parentless tracker, so its behaviour is untouched. The change is confined to `lib/llm/run-budget.ts` with matching tests in `lib/llm/run-budget.test.ts`.

Watch for: nothing blocking. The `charge`-at-child-price cost model and the deliberately unsliced run clock are both correct design choices and are noted below for context (confirmed).

**Verdict**: APPROVED

## High-level view

The ledger holds the run's resolved limits and sums tokens, cost and wall-clock across all workers; `child(modelKey, share)` hands back a `RunBudgetTracker` whose own token and cost ceilings are `(remaining limit) × share`, capturing the slice at worker-start time so a later worker sees less headroom than an earlier one. This matches req 8.2 exactly — slices are of *remaining*, not *total*, so no set of workers can collectively exceed the run.

Dual charging (req 8.3) is a single `this.parent?.charge(...)` added to `recordStep`, and exhaustion reporting (req 8.1) is a single `?? this.parent?.exhausted()` added to `exceeded()`. Both are no-ops when `parent` is undefined, which is how the single-agent path stays byte-for-byte equivalent. Loop detection (req 8.5) was left entirely on the child tracker and the ledger has no call-counting at all, so repeats are scoped per worker as required.

The one design decision worth naming: run cost is accumulated at each child's own model price (the ledger does no pricing of its own), and the shared clock is passed to children rather than sliced. Both are the right calls and are explained below rather than flagged as risks.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. The two items discussed in the details block are confirmed-correct design decisions, not action items.

</details>

<details>
<summary>Details</summary>

### Slice capping is of remaining, not total (req 8.2)

`child()` computes each limit as `scaleRemaining(limit, used, share)` = `max(0, limit − used) × share`, reading `this.tokens` and `this.costUsd` at the instant the worker starts. The test drives this precisely: with a 1,000-token run and `share=0.5`, the first worker gets a 500-token slice; after it spends all 500, a second worker starting then gets `(1000 − 500) × 0.5 = 250`. This is the correct reading of "a share of the run ledger's remaining tokens and cost when the worker starts" — slicing *total* instead of *remaining* would let N workers each claim `share × total` and collectively blow past the run ceiling, which is exactly the failure req 8 exists to prevent (confirmed).

`share` is clamped to `[0,1]` before use, so a malformed `WORKER_BUDGET_SHARE` can't hand a worker more than the full remaining budget or a negative slice (confirmed).

### Exhaustion overrides a child with room (req 8.1)

`exceeded()` returns `this.stopReason ?? this.parent?.exhausted()`. The child's own reason wins when set; otherwise the ledger's reason surfaces. The `maxTokens: 300, share=1` test makes the asymmetry concrete: worker `b` has spent nothing of its own full-300 slice, yet once worker `a` drains the shared 300 the ledger reports `token-budget` and `b.exceeded()` returns it. Without the `?? parent.exhausted()` fallback, `b` would keep running against a run that is already over budget. This is the behaviour req 8.4 will later depend on to force wrap-up on in-flight workers (confirmed).

### Run cost is charged at the child's model price

The ledger does no pricing itself; `recordStep` computes `stepCost` from the child's own `modelKey` via `estimateCostUsd` and passes that figure to `parent.charge`. So a run mixing a cheap worker model and an expensive one accumulates each step at the price of the model that actually ran it, which is the only correct way to total heterogeneous workers. The unpriced-model semantics carry over cleanly: if any charged step has an undefined cost, the ledger's `costUsd` latches to `undefined` (same `=== undefined ? undefined : +` guard as the tracker), so a run with any unpriced worker simply stops enforcing the cost ceiling rather than under-counting. The cost-ceiling test exercises two priced workers summing to exactly the $5 limit and confirms `cost-budget` fires at the boundary (confirmed).

### The run clock is shared, not sliced

`child()` passes the ledger's `startedAt` and `now` straight through and copies `maxDurationMs` unscaled, so every worker measures against the same wall clock and the same deadline — time is not a divisible resource the way tokens and cost are, so forwarding the shared clock rather than slicing it per worker is the non-obvious but correct choice. The time-exhaustion test confirms `exhausted()` re-checks `now()` on each call rather than caching (confirmed).

### Single-agent path is unchanged

The new `parent` parameter is optional and defaults to undefined; `recordStep`'s `this.parent?.charge` and `exceeded()`'s `?? this.parent?.exhausted()` are both inert without it, and no existing call site had to change because the fifth argument is additive. The "no parent behaves exactly as before" test asserts the same token-budget stop as the original suite (confirmed).

### Test coverage

The added `RunLedger` suite covers all four requirements in scope: slice capping of remaining (8.2), dual charging with the ledger summing across workers (8.1/8.3), ledger exhaustion surfacing to a worker whose slice has room (8.1), cost-ceiling exhaustion across priced workers (8.1), time-limit re-checking (8.1), per-worker loop isolation where one worker loops and the other is unaffected (8.5), and the unchanged no-parent path. Boundary conditions are tested at the `>=` edge for both tokens and cost.

Not tested: the `share` clamp itself (no case feeds a negative or >1 share to confirm the clamp), and a mixed priced/unpriced worker set that latches ledger cost to `undefined`. Both are low-risk — the clamp is a two-function `min/max` and the undefined-latch reuses the already-tested tracker guard — and neither blocks the task, whose required semantics are all covered.

</details>

<details>
<summary>File map</summary>

- `lib/llm/run-budget.ts` — new `RunLedger` class, optional `parent` on `RunBudgetTracker`, `charge`/`exhausted`/`scaleRemaining` helpers; `recordStep` and `exceeded` charge/consult the parent.
- `lib/llm/run-budget.test.ts` — new `RunLedger` describe block (8 cases) covering reqs 8.1, 8.2, 8.3, 8.5.
- `.kiro/specs/orchestrator-workers/tasks.md` — tasks 4 and 4.1 checked off.
- `.agents/tasks/ci-task4.md` — CI evidence (tsc, lint, 511 tests, build all green; targeted 16-test run green).

Full diff: `git -C .worktrees/orchestrator-workers show`

</details>
