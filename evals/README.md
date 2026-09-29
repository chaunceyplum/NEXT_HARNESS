# Evals

Separate from `**/*.test.ts` (`npm test`) on purpose. Unit tests stub the
model, the MCP server, and the embedding provider so they stay fast, free,
and deterministic. Evals call the **real, configured** providers against
**hand-reviewed fixtures**, to measure what unit tests structurally can't:
whether the model's behavior is actually *good*, not just correctly
*handled*.

They're a manual step, not a CI gate, until the suite is stable enough to
trust on every PR.

## Suites

| Command | What it grades | Needs |
| --- | --- | --- |
| `npm run eval:shortlist` | `shortlistTools()` against the **live** MCP catalog: does the shortlist the agent would get contain the tools the task needs? A tool that misses the shortlist can't be called at all. | `MCP_ENDPOINT_URL` (+ an embedding provider, else the lexical fallback is graded — the run records which) |
| `npm run eval:agent` | The real `runAgent()` loop and system prompt with a real chat model, against **scripted** tools: right tool, no unrequested writes, read-before-commit, stop after repeated failures, say plainly when no tool fits. | Credentials for `EVAL_MODEL` (default `DEFAULT_MODEL`) |
| `npm run eval:rag-judge` | Calibration of the production RAG judge (`lib/llm/rag-judge.ts`) on canned retrievals: does its verdict agree with a human's? | Credentials for `RAG_JUDGE_MODEL` (default `DEFAULT_MODEL`) |
| `npm run eval:all` | All three. | |

A suite with nothing configured skips itself with a printed reason instead
of failing. Each run prints a per-fixture PASS/FAIL table with why (and
duration/tokens for the agent suite), plus an overall score.

### Comparing models

```bash
EVAL_MODEL=bedrock:cheap npm run eval:agent
EVAL_MODEL=bedrock:balanced npm run eval:agent
```

The judge (`EVAL_JUDGE_MODEL`, default `DEFAULT_MODEL`) stays fixed across
both, so the scores are comparable. Pinning `EVAL_MODEL` also disables the
same-tier model fallback, so a score is always for the model you named.

## Why the agent suite uses scripted tools

Most tools in the catalog **write** to a real AEP/CJA/Reactor org. Grading
"does the agent create a segment without also activating it" must not
actually create one, and must be repeatable. So the platform is scripted
(`lib/scripted-tools.ts`: canned responses, including errors, replayed in
order) and only the model is real. `runAgent()` takes the scripted tool set
via its `tools` option and otherwise runs exactly as `/api/build` does.

Fixture tools may leave out `description`/`inputSchema` to use the real
definition — from `lib/llm/local-tools.ts` for the `github_*` tools, or from
the live MCP catalog when `MCP_ENDPOINT_URL` is set. Prefer that, or copy the
live description, so the model sees what it sees in production.

## Viewing results

Every run is also saved (best-effort) to `harness_eval_runs` /
`harness_eval_results` in the MCP server's database, via `execute_sql` —
the same place `harness_agent_runs` lives (`lib/eval-store.ts`). Browse the
history at **`/evals`**: runs by suite with pass rate, the model or
retrieval mode graded, and each fixture's notes. A save failure (e.g. no
`MCP_ENDPOINT_URL`) is logged and never fails the eval. The page is
view-only; it never runs an eval or reaches a model.

## Adding a fixture

Drop a `*.json` file into the right `fixtures/<suite>` directory — no code
change needed. See existing fixtures for the shape; each `.eval.ts` file
declares exactly which fields it reads. Every fixture needs an `id` (or the
filename is used) and a `note` saying what it's there to catch.

- **agent**: `request`, `tools[]` (`name`, optional `description`/
  `inputSchema`, `responses[]` of `{ "result": … }` or `{ "error": "…" }`),
  and `expected`: `mustCall`, `mustNotCall`, `callOrder`, `maxToolCalls`,
  `maxCallsPerTool`, `argsContain`, `finishReasons`, optional `rubric`.
- **tool-shortlist**: `request`, `expectedTools`, optional `k` (default 24,
  the agent's own default) and `minRecall` (default 1).
- **rag-judge**: `query`, canned `output`, and `expected`: `verdictOneOf`,
  `sufficient`, `relevanceMin`/`relevanceMax`.

**Where fixtures come from**: real run history first. `/results` (the
`harness_agent_runs` table) has real requests and full tool-call traces —
take one where the agent did something wrong (looped on a failing call,
touched a tool it wasn't asked to, missed the tool it needed), turn the
tool results it saw into scripted `responses`, write down what *should*
have happened, and check it in. A fixture records the correct behavior, not
what happened. The current fixtures encode the system prompt's own rules
(`lib/llm/agent-core.ts`) and are synthetic until real regressions replace
them.

## Grading philosophy

- **Structural first.** Which tools were called, how often, in what order,
  with what arguments, and why the loop finished are exact checks
  (`lib/grading.ts`, unit-tested in `lib/grading.test.ts` as part of
  `npm test`). No judge is more reliable than an exact match where one is
  possible.
- **The judge (`lib/judge.ts`) is only for what the agent *says*** — "does
  the answer admit no tool can build an AJO journey," "does it explain
  what's blocking instead of claiming success." It costs one extra model
  call per rubric fixture.
- **A stale fixture is not a model failure.** The shortlist suite checks
  every expected tool is in the live catalog first and reports "fixture
  stale" rather than a retrieval miss if the server dropped or renamed it.
