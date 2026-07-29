# harness-agent-loop

The Step Functions Standard workflow that replaces `lib/llm/agent.ts`'s old
in-process `runAgent()` loop. See `statemachine/harness-agent-loop.asl.json`
for the state graph and `lambdas/` for what each state does; the top-level
migration spec (in the conversation/PR this shipped from) has the full
rationale.

## Deploy

```bash
npm run build:aws        # esbuild-bundles lambdas/*/index.ts -> dist/*/index.mjs
cd aws
sam build
sam deploy --guided
```

First `--guided` deploy asks for (all in `template.yaml`'s `Parameters`):
- `McpEndpointUrl` — same value as the harness's `MCP_ENDPOINT_URL`
- `McpApiKey` / `McpAuthToken` — only if the MCP API Gateway stage requires them
- `AnthropicApiKey` / `OpenAiApiKey` — only for the model keys you actually use
- `EmbeddingProvider` / `EmbeddingModelId` — only to override `lib/llm/embeddings.ts`'s auto-detection
- `GatedTools` — comma-separated tool names requiring human approval (default covers `msb_execute_solution`, `msb_github_commit_code`, `msb_github_merge_pr`, `msb_netlify_trigger_deploy`, `execute_sql`)
- `ToolRetries` — default `1`
- `HarnessApprovalsTopicArn` — optional SNS topic for approval notifications
- `GitHubToken` — a fine-grained GitHub PAT with **read-only "Contents" access** to whichever repo(s) you want the agent able to read (not the repo(s) it writes to necessarily — those are separate concerns; see below). Leave blank to leave `github_read_file`/`github_list_directory` non-functional (they'll fail with a clear "not configured" error rather than silently vanishing from the tool list).

Take the `StateMachineArn` output and set it as `HARNESS_STATE_MACHINE_ARN`
in the Next.js harness's `.env.local`. Attach the `NextJsControlPlanePolicyArn`
output (a standalone managed policy) to whatever IAM principal the Next.js
app authenticates as — an IAM user + access key if it's hosted off-AWS
(e.g. Vercel), an instance/task role if it moves onto AWS later.

## Redeploying after a code change

`npm run build:aws && cd aws && sam build && sam deploy` picks up changes to
any `lambdas/*/index.ts` or the ASL definition. No parameter re-entry needed
unless a parameter value itself changed. `npm run deploy:aws` (from the repo
root) does all three in one command.

## Local sanity-check without deploying

```bash
npm run build:aws
node -e "import('./aws/dist/finalize/index.mjs').then(m => console.log(typeof m.handler))"
```

Confirms the bundle loads and exports `handler` — it does not exercise the
handler itself (that needs a live MCP endpoint + Postgres + Step Functions
execution context).

## Testing the state machine before touching Next.js

1. **Happy path**: start an execution from the AWS Console with a harmless
   description (`{"runId": "test-1", "description": "list my CJA data views", "modelKey": "bedrock:cheap", "allowFullBuild": false, "maxSteps": 10, "toolShortlistSize": 12, "toolRetries": 1}`).
   Watch the graph; confirm `harness_agent_runs.messages` grows per step and
   the run reaches `COMPLETED`.
2. **Approval path**: a description that triggers a gated tool with
   `allowFullBuild: true`. Confirm the execution parks at `RequestApproval`
   and `harness_approvals` has a `PENDING` row. Resolve it directly via the
   CLI to test independent of the Next.js routes:
   ```bash
   aws stepfunctions send-task-success --task-token <token> --task-output '{"approved":true}'
   # or, to test rejection:
   aws stepfunctions send-task-failure --task-token <token> --error HumanRejected --cause '{"feedback":"try a narrower query"}'
   ```
   Confirm the run resumes and (on rejection) the model's next turn
   addresses the feedback rather than repeating the identical call.

## Repo read access and the pre-commit check

The MCP server's own GitHub tools (`msb_github_commit_code`,
`msb_github_create_branch`, `msb_github_create_pr`, `msb_github_get_pr_status`,
`msb_github_merge_pr`) are write/status-only — there's no read tool in that
catalog, and that server isn't this repo's to modify. `lib/llm/local-tools.ts`
closes that specific gap with two tools that bypass the MCP entirely and call
GitHub's REST API directly:

- `github_read_file(owner, repo, path, ref?)`
- `github_list_directory(owner, repo, path?, ref?)`

Both are always-on (`ALWAYS_ON_TOOLS` in `lib/llm/agent-core.ts`) and require
`GitHubToken` above to be set on `ExecToolsFunction` — the only Lambda that
actually executes tools (`agent-step` only proposes them as stubs). The
system prompt tells the model to read a file before proposing a change to
it, but this is a prompt instruction, not an enforced constraint — nothing
currently blocks `msb_github_commit_code` from being called without a prior
read.

Separately, every `msb_github_commit_code` call is now gated (human approval
required — see `GatedTools` above) **and** syntax-checked before the commit
is attempted (`lib/llm/commit-validation.ts`, wired into `callTool` in
`lib/llm/tool-catalog.ts`, so it runs on every retry attempt, not just once).
Be precise about what that check is:

- ✅ Valid JSON for `.json` files, no JS/TS/JSX parse errors for
  `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files (via `ts.transpileModule`,
  syntax diagnostics only).
- ❌ **Not** a real build — it never checks out the target repo, installs
  its dependencies, or runs its actual build/test/typecheck. A file can
  pass this and still not compile against the rest of that codebase, use
  the wrong import paths, violate its lint rules, or just be wrong.
- ❌ No check at all for other extensions (`.css`, `.md`, `.html`, `.yaml`, …)
  — nothing lightweight exists to validate those here, so they pass through
  unvalidated rather than false-failing.

If you need real build/test verification before a commit or before merge,
that has to happen either in the target repo's own CI (required status
checks on the PR, which `msb_github_merge_pr` being gated at least ensures
a human sees before merging) or by giving the harness an actual sandboxed
checkout — neither exists today.

## Known gotchas (see also the top-level migration notes)

- **256KB inter-state payload limit** — the ASL passes only a small control
  envelope (`aws/lambdas/_shared/envelope.ts`); every Lambda loads/saves the
  real state from Postgres via `lib/execution-store.ts`.
- **`SendTaskSuccess`/`SendTaskFailure` have no resource-level ARNs** —
  token possession is the actual authorization. `loadApproval()`'s
  `task_token` must never be returned by any read API; `listPendingApprovals()`
  never even selects that column.
- **`execute_sql` has no parameter binding** — every write goes through the
  hand-escaping helpers in `lib/execution-store.ts`; jsonb writes strip the
  NUL byte, which Postgres rejects but `JSON.stringify` passes through
  unescaped.
- **A retried `AgentStep` after `States.Timeout`** could, in principle,
  double-run a model call that actually succeeded but timed out before its
  checkpoint landed — a duplicated assistant turn is benign (the model just
  sees its own prior turn again), not corrective. Not made idempotent on
  `(runId, stepCount)` for now; revisit if it becomes a real problem.
- **Dangling tool calls are not allowed** — every `tool-call` part must get
  a matching `tool-result` (including on human rejection, via
  `inject-rejection`) or the next model call is rejected by the provider
  API with a 400.
