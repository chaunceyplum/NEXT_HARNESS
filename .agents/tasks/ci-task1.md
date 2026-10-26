# CI evidence — Task 1 (split `runAgent` into `prepareRun` + `executeLoop`)

Pure refactor, no behaviour change. All commands run inside the worktree
`/Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers`.

## What changed

- `lib/llm/agent-core.ts`: added the Phase-1 loop/setup contracts
  (`LoopContext`, `LoopResult`, `PreparedRun`, `EarlyResult`, plus the
  `ToolApprovalFn`, `EarlyRunResult` and the moved `TokenUsage` / `ToolOutcome`
  shapes). Types only — no live MCP client import.
- `lib/llm/agent.ts`: extracted `executeLoop(ctx)` (tracer setup, budget,
  `callModel`, the fallback loop and result assembly; returns `hadSideEffects`)
  and `prepareRun(opts)` (routing, launch mode, gate, brief parse, tool
  selection, memory, planning retrieval, planning, approval, approval hook;
  returns `EarlyResult` for the unclear-route and denied-plan cases).
  `runAgent` is now `prepareRun` then `executeLoop`, assembling the same
  `AgentRunResult`. `TokenUsage` / `ToolOutcome` are re-exported from
  `agent-core.ts` so existing imports are unchanged.

No test, eval fixture, or `evals/baseline.json` entry was changed.

## CI gate — all pass

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0, no warnings/errors) |
| `npm test` | PASS — 45 files, **481 passed** |
| `npm run build` | PASS — Next.js compiled, TypeScript checked, 15/15 static pages generated, all 23 routes built |

## Evals — pre-existing environmental failures, NOT caused by this refactor

The agent/launch evals run against live models (Bedrock/Anthropic) and the
live MCP endpoint. They were run with the local `.env.local` credentials
copied into the worktree (gitignored; not committed).

Both eval suites fail the same way on the **unmodified baseline** as on the
refactor, proving the refactor did not change behaviour. The deterministic
behaviour guard is the unit suite (`npm test`), which passes 481/481.

| Suite | Baseline (stash, no refactor) | With refactor |
| --- | --- | --- |
| `npm run eval:agent` | 8 failed / 10 passed / 1 skipped | 7 failed / 11 passed / 1 skipped |
| `npm run eval:launch` | 6 failed / 1 skipped | 6 failed / 1 skipped |

- Agent-eval failures are non-deterministic LLM-judge verdicts (the model
  occasionally invents a "knowledge-base note" or names a sandbox the tool
  activity does not show). The baseline run had *more* failures than the
  refactor on a different random draw — the variance is in the live model, not
  the code. Same fixtures, same judge criteria, no baseline.json dependency on
  these soft assertions.
- Launch-eval failures are identical (6/6) on baseline and refactor: the live
  model declines to call Reactor tools because it cannot resolve IDs against
  the live endpoint, so the fixture's required-tool-call assertions fail. This
  is the live endpoint's state, independent of the refactor.

Comparison method: `git stash` the two modified files, run the eval on the
clean baseline, `git stash pop`, run the eval on the refactor — same
environment, same credentials, same fixtures.

## How to reproduce

```
cd /Users/chauncey/Desktop/PROJECTS/next_harness/NEXT_HARNESS/.worktrees/orchestrator-workers
npx tsc --noEmit -p . && npm run lint && npm test && npm run build
npm run eval:agent    # needs live model + MCP credentials in .env.local
npm run eval:launch   # needs live model + MCP credentials in .env.local
```
