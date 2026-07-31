# harness-agent-loop (Step Functions)

Runs the agent loop for `POST /api/build` as a Step Functions Standard
workflow instead of one long-lived Next.js request — fixes the platform
request-timeout problem (Netlify/Vercel/etc. all cap how long a single HTTP
request can stay open; a multi-step agent run with several tool calls and
model round-trips can easily exceed that).

This is a trimmed build: no human-approval gate, no tickets, no autonomous
mode. A run either completes, fails, or hits its step limit (`MAX_STEPS`).
A companion solutions-architecture document (state machine flow, what each
Lambda does, why Postgres owns the large state) was shared separately —
this README covers deploying it.

## Prerequisites

- AWS CLI configured with credentials that can create Lambda functions, a
  Step Functions state machine, IAM roles/policies, and CloudFormation
  stacks.
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) installed.
- Node.js 20+ (for the esbuild bundling step — matches the Lambda runtime).
- Bedrock model access enabled in the target AWS account/region (Console →
  Bedrock → Model access), if you're using the default `bedrock:*` models.

## Deploy

From the repo root:

```bash
npm run build:aws        # esbuild-bundles each Lambda into aws/dist/<name>/index.mjs
cd aws
sam build
sam deploy --guided
```

`sam deploy --guided` walks you through stack name, region, and every
`Parameter` in `template.yaml` — here's exactly what to have ready:

| Parameter | Required? | What to plug in |
|---|---|---|
| `McpEndpointUrl` | **Yes** | Same value as your `.env.local`'s `MCP_ENDPOINT_URL`. |
| `McpApiKey` | Only if your MCP API Gateway stage requires `x-api-key` | Same as `.env.local`'s `MCP_API_KEY`. |
| `McpAuthToken` | Only if MCP is behind a bearer-token authorizer | Same as `.env.local`'s `MCP_AUTH_TOKEN`. |
| `AnthropicApiKey` | Only if you'll pick `anthropic:*` model keys | Your Anthropic API key. |
| `OpenAiApiKey` | Only if you'll pick `openai:*` models, or use OpenAI embeddings | Your OpenAI API key. |
| `EmbeddingProvider` / `EmbeddingModelId` | No — auto-detects | Leave blank unless you need to override. |
| `ToolRetries` | No | Defaults to `1`. |
| `GitHubToken` | Only if you want `github_read_file`/`github_list_directory` to work | A fine-grained GitHub PAT, read-only "Contents" access on the target repo(s). |

Save your answers to `samconfig.toml` when prompted so future
`sam build && sam deploy` runs don't re-ask.

## After it deploys

`sam deploy`'s output (also visible any time via `aws cloudformation
describe-stacks --stack-name <your-stack-name>`) gives you two things to
plug back into the Next.js app:

1. **`StateMachineArn`** → set as `HARNESS_STATE_MACHINE_ARN` in whatever
   env you deploy the Next.js app to (Netlify: Site configuration →
   Environment variables). Redeploy the Next.js app after setting it —
   env vars only take effect on the next build.
2. **`NextJsControlPlanePolicyArn`** → attach this managed policy to
   whatever IAM principal the Next.js app authenticates as (an IAM user +
   access key if it's hosted off-AWS, which is the Netlify case — set
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` for that user
   alongside the Bedrock ones you may already have).

Once both are set and the app is redeployed, `POST /api/build` starts a
Step Functions execution and returns `202 { runId, status: 'PENDING' }`
immediately — the run itself continues in Step Functions regardless of how
long it takes. `GET /api/runs/:runId` (polled by `/results/:id`) reflects
live progress.

**`?sync=1` escape hatch**: append `?sync=1` to a `POST /api/build` request
to bypass Step Functions entirely and run the whole agent loop in-process
instead (the original synchronous behavior) — useful for quick local
testing without a deployed state machine. Still subject to whatever request
timeout your host enforces.

## Redeploying after a code change

Any change under `lib/` (the agent, tool catalog, execution store, etc.) or
`aws/lambdas/` needs a rebuild + redeploy to reach the Lambdas:

```bash
npm run build:aws && cd aws && sam build && sam deploy
```

(`npm run deploy:aws` does both build steps in one command.)

## Testing a run end-to-end

```bash
curl -X POST https://<your-netlify-site>/api/build \
  -H 'Content-Type: application/json' \
  -d '{"description": "Add a banner to the mediahive home page that says 20% off all plans"}'
# -> { "runId": "...", "status": "PENDING" }

curl https://<your-netlify-site>/api/runs/<runId>
# -> poll this until status is COMPLETED/FAILED/MAX_STEPS
```

Or just use the UI at `/` — it redirects to `/results/:runId`, which polls
automatically.

## What's deliberately NOT in this build (fast-follow candidates)

- **Automated purge** of old `harness_agent_runs` rows — for now, run a
  manual `DELETE FROM harness_agent_runs WHERE created_at < now() -
  interval '90 days'` via `execute_sql` (or any Postgres client against the
  MCP's database) periodically.
- **Secrets Manager / SSM** for the API keys above — they're plain Lambda
  environment variables for now.
- **Human-approval gate** on high-impact tools (`msb_execute_solution`,
  `msb_github_commit_code`, etc.) — every run is fully autonomous once
  started.
- **CloudWatch alarms** on failed executions.
- **Concurrency limits** to cap cost if many runs start at once.
