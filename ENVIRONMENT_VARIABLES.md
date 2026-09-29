# Environment Variables Guide

## Required Variables

### `MCP_ENDPOINT_URL` (REQUIRED)

**What it is**: The URL to your MCP Lambda backend via API Gateway

**Where to get it**:
1. From your SAM deployment outputs:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name mcp \
     --query 'Stacks[0].Outputs[?OutputKey==`McpEndpointUrl`].OutputValue' \
     --output text
   ```

2. Or from AWS Console:
   - Go to CloudFormation → Stacks → mcp → Outputs
   - Look for `McpEndpointUrl`

**Format**:
```
https://<api-gateway-id>.execute-api.<region>.amazonaws.com/mcp
```

**Example**:
```
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
```

**Used by**: 
- `lib/mcp-client.ts` — HTTP bridge to call MCP tools
- All API routes — Build, status, artifacts

**What happens if missing**:
```
Error: MCP_ENDPOINT_URL is not set. Please configure it in .env.local
```

### `MCP_API_KEY` / `MCP_AUTH_TOKEN` (required if your API Gateway stage enforces auth)

`lib/mcp-client.ts` sends no auth header unless one of these is set. A bare
`403 Forbidden` with no JSON error body (surfaces as `[MCP tool catalog
(tools/list)] HTTP 403: Forbidden` after the agent's error-tagging) is the
standard AWS API Gateway response when a required API key is missing —
that's the first thing to check if you hit it.

```bash
# If your API Gateway stage has a usage plan / API key requirement:
MCP_API_KEY=<your-api-gateway-key>       # sent as x-api-key

# If it's fronted by a Lambda authorizer expecting a bearer token instead:
MCP_AUTH_TOKEN=<your-token>              # sent as Authorization: Bearer <token>
```

### `GITHUB_TOKEN` (optional — enables the agent's GitHub read tools)

**What it is**: a fine-grained GitHub PAT with read-only "Contents" access
to whichever repo(s) you want the agent able to read via `github_read_file`/
`github_list_directory` (`lib/llm/local-tools.ts`) before proposing a change
to existing code with the MCP server's `msb_github_commit_code` tool.
These two read tools call GitHub's REST API directly — the MCP server has
no read tool of its own.

**What happens if missing**: the two read tools fail with a clear
"GITHUB_TOKEN is not configured" error when called, rather than silently
disappearing from the tool list — the agent will know to say so instead of
guessing at file contents.

---

## Authentication (`proxy.ts`, `lib/auth.ts`) — required in production

Every page and API route is authenticated. **A production build with none
of these set refuses every request with 503**, so set at least one before
deploying. `next dev` allows unauthenticated requests.

| Variable | Format | Purpose |
| --- | --- | --- |
| `HARNESS_AUTH_USERS` | `alice:password,bob:password` | HTTP Basic for people. The browser shows its sign-in prompt. |
| `HARNESS_API_TOKENS` | `ci-bot:token,cron:token` | `Authorization: Bearer <token>` for scripts. The name before `:` is the identity. |
| `HARNESS_APPROVERS` | `alice,carol` | Only these users may approve or deny paused tool calls. Unset = any signed-in user. |
| `HARNESS_AUTH_DISABLED` | `true` | Explicit opt-out, e.g. behind a VPN or an authenticating load balancer. |

The authenticated name is passed to route handlers in the `x-harness-user`
header. The proxy overwrites any value a client sends. Approval decisions
record who made them. Serve the app over HTTPS: Basic credentials are
only base64-encoded.

## LLM Provider Variables (agent — lib/llm/)

The `/api/build` route no longer runs a fixed planner→orchestrator pipeline.
It runs an agent (lib/llm/agent.ts) that shortlists relevant MCP tools and
lets an LLM decide which ones to call. The model is swappable per request —
these variables control which providers/models are available to pick from.

### Bedrock (default provider — no Anthropic API key needed)

`bedrock:cheap` / `bedrock:balanced` / `bedrock:expensive` are in the
registry unconditionally, and `bedrock:balanced` is the default model
(`DEFAULT_MODEL` below) — you only need AWS credentials, not an Anthropic
API key, to run the harness. Ships with well-known, stable Claude-on-Bedrock
model IDs; override per tier if your account needs different ones (some
accounts require cross-region inference profile IDs instead, prefixed like
`us.anthropic...` — that's the first thing to check if you get a "model not
found" error with the defaults). Confirm what's available to you with:
```bash
aws bedrock list-foundation-models --query 'modelSummaries[].modelId'
```

```bash
BEDROCK_CHEAP_MODEL_ID=anthropic.claude-haiku-4-5-20251001-v1:0       # default shown
BEDROCK_BALANCED_MODEL_ID=anthropic.claude-sonnet-5   # default shown
BEDROCK_EXPENSIVE_MODEL_ID=anthropic.claude-opus-4-8      # default shown
# Optional friendlier labels shown in the UI:
BEDROCK_CHEAP_MODEL_ID_LABEL=Claude Haiku 4.5

# Credentials: if unset, falls back to the default AWS credential provider
# chain (env vars, shared config, instance/task role, SSO). Also requires
# model access granted in AWS Console -> Bedrock -> Model access (separate
# from IAM, opt-in per model per region).
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...      # real values only; leave unset to use the default chain
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...          # only if using temporary credentials
```

### `DEFAULT_MODEL` (optional)

Registry key used when a build request doesn't specify `model`. Defaults to
`bedrock:balanced`. Example: `DEFAULT_MODEL=bedrock:cheap` to default to
the cheapest option, or `DEFAULT_MODEL=anthropic:sonnet` to default to
Anthropic direct instead.

### Model-health circuit breaker (optional — `lib/llm/model-health.ts`)

When a request does **not** pin a specific `model` (i.e. it uses
`DEFAULT_MODEL`), the agent now routes around a model that is failing on
provider-side access/auth/quota errors — the dominant failure class in the
harness's own execution history — by retrying against the next healthy model
in the same tier. A pinned model still surfaces its own error unchanged, and a
context-length overflow is *not* treated as a health failure (a same-tier
sibling shares the same context window). The breaker's thresholds are tunable:

```bash
MODEL_HEALTH_FAILURE_THRESHOLD=2      # provider failures in the window before a model is tripped
MODEL_HEALTH_WINDOW_MS=900000         # rolling window (default 15m)
MODEL_HEALTH_COOLDOWN_MS=600000       # how long a tripped model stays out (default 10m)
```

Note: this reroutes around a model with no verified access, but it can't
*grant* access. If a tier has no healthy alternative (e.g. Bedrock model
access isn't granted for any model in it — AWS Console → Bedrock → Model
access), the underlying provider error is still surfaced; fix the grant.

### `ANTHROPIC_API_KEY` (optional — only for the `anthropic:*` entries)

Used by the `anthropic:*` registry entries: `anthropic:haiku` (Claude
Haiku 4.5), `anthropic:sonnet` (Claude Sonnet 5), `anthropic:sonnet-5-5`
(Claude Sonnet 5.5), `anthropic:opus` (Claude Opus 4.8) and
`anthropic:opus-5-5` (Claude Opus 5.5). They're an alternative to Bedrock,
not the default. To run on the Claude API, set **both** the key and
`DEFAULT_MODEL`. The key alone still sends every request to
`bedrock:balanced`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
DEFAULT_MODEL=anthropic:sonnet
```

### OpenAI entries (optional)

```bash
OPENAI_API_KEY=sk-...
OPENAI_CHEAP_MODEL_ID=gpt-4o-mini
OPENAI_BALANCED_MODEL_ID=gpt-4o
```

### `MODEL_REGISTRY_JSON` (optional escape hatch)

Add arbitrary extra entries (more Bedrock foundation models — Llama, Nova,
Mistral — or anything else) without touching code:
```bash
MODEL_REGISTRY_JSON='[{"key":"bedrock:llama","label":"Llama 3.1 70B (Bedrock)","provider":"bedrock","modelId":"meta.llama3-1-70b-instruct-v1:0","tier":"cheap"}]'
```

### Tool-shortlisting embeddings (optional — has a no-credentials fallback)

The agent embeds the MCP tool catalog once per process to semantically
shortlist relevant tools per request (lib/llm/tool-retrieval.ts). This
needs a *second* provider beyond your chat model — Anthropic has no
embeddings API, so this always goes through OpenAI or Bedrock regardless
of which chat model you pick. Uses OpenAI if `OPENAI_API_KEY` is set,
otherwise falls back to Bedrock Titan embeddings.

**If neither is configured (or the embedding call fails for any reason —
missing AWS credentials, no Bedrock model access, etc.), tool-shortlisting
automatically falls back to plain keyword matching instead of failing the
whole request.** Less accurate than semantic search, but it means the
harness still runs with zero extra credentials beyond whatever's already
configured for your chat model. Configure one of these to upgrade to
semantic shortlisting:

```bash
EMBEDDING_PROVIDER=openai        # or "bedrock" — auto-detected if unset
EMBEDDING_MODEL_ID=text-embedding-3-small   # or a Bedrock Titan embedding model id
```

### RAG judge (optional — samples by default, `lib/llm/rag-judge.ts`)

A sample of the agent's own `search_adobe_knowledge`/`search_all_agents`
calls (10% by default) is scored by a second LLM call for relevance and
sufficiency, and the judgment rides along on the tool result as
`_ragJudgment`. It's for monitoring retrieval quality — the agent doesn't
act on it — so it doesn't run on every search. Empty results are never
judged, and neither are the knowledge-base lookups attached to tool
failures (below). The knowledge base already reranks its own results
server-side — this judge doesn't re-rank or second-guess that ordering, it
only grades whether what actually came back is good enough to act on. A
judge failure (bad credentials, model error) is logged and swallowed; it
never fails the underlying RAG call. The rag-judge eval calls the judge
directly and is unaffected by sampling.

On a tool failure, a knowledge-base lookup is attached to the error only
when it's needed: a validation error on a tool that already failed
validation earlier in the run, or one whose message names nothing the model
could fix (e.g. a bare `400: Bad Request`). Identical lookups in a run are
made once. Transient errors (5xx, timeouts, 429) are retried with back-off
and never looked up.

```bash
RAG_JUDGE_ENABLED=false     # disable entirely
RAG_JUDGE_SAMPLE_RATE=0.1   # share of searches judged, 0–1 (1 = every search)
RAG_JUDGE_MODEL=bedrock:cheap   # any registry key; defaults to DEFAULT_MODEL
```

---

## Tool call timeouts (`lib/fetch-timeout.ts`)

Every outbound request in the tool path has a deadline. A timeout surfaces
as `… timed out after Ns (timeout)`, which the retry logic treats as
transient. Stopping a run aborts its in-flight tool requests and skips
remaining retries. Retry back-off is jittered (50–100% of 500ms·2ⁿ, or
2s·2ⁿ for rate limits).

| Variable | Default | Applies to |
| --- | --- | --- |
| `MCP_TOOL_TIMEOUT_MS` | `60000` | Each MCP `tools/call` |
| `MCP_LIST_TIMEOUT_MS` | `30000` | MCP `tools/list` |
| `GITHUB_TIMEOUT_MS` | `30000` | `github_read_file` / `github_list_directory` |

## Run budgets (`lib/llm/run-budget.ts`)

Hard limits enforced in code on top of the step cap. When one is hit, the
next step is forced to be a written wrap-up (no more tool calls), and the
run's `stopReason` is set so the UI flags the answer as partial.

| Variable | Default | Limit |
| --- | --- | --- |
| `RUN_MAX_TOKENS` | `1500000` | Input + output tokens across all steps |
| `RUN_MAX_COST_USD` | none | Estimated cost via `lib/llm/pricing.ts` (ignored for unpriced models) |
| `RUN_TIMEOUT_MS` | `1800000` | Wall-clock time; checked between steps, hard abort 5 minutes later |
| `RUN_MAX_IDENTICAL_CALLS` | `3` | Same tool with identical arguments: the model is warned at this count, and the run stops if it repeats again |

A request can set tighter `maxTokens` / `maxCostUsd`, never looser ones.

## Approvals and rollout mode (`lib/llm/approval-policy.ts`)

These calls pause for Approve/Deny on the home page before they run:

| Reason | Calls |
| --- | --- |
| destructive | `delete_*`, `abort_*`, `msb_github_merge_pr`, privacy jobs |
| sql-write | `execute_sql` unless the SQL is one read-only statement (`SELECT`/`WITH`/`EXPLAIN`/`SHOW`, no write keywords, no side-effect functions) |
| outbound | commits, PRs, branches, export jobs, destination connections/dataflows, Launch callbacks/hosts, Launch library build/transition |
| credentials | `flow_get_landing_zone_credentials`, `reactor_get_secret`, `reactor_list_secrets` |

- `APPROVAL_TIMEOUT_MS` (default `600000`): how long a call waits before it's denied.
- `ROLLOUT_MODE` (default `autonomous`): `assisted` also asks before every
  write; `shadow` dry-runs every write (nothing executes, nothing to
  approve except credential reads). A request's `rolloutMode` can pick a
  stricter mode, never a looser one.

## Kill switch (`lib/kill-switch.ts`)

- **Stop all runs** (home page) or `POST /api/admin/kill-switch
  {"engaged":true,"reason":"…"}` aborts every active run within seconds.
  Pending approvals are denied and in-flight model calls are cancelled.
  New runs are refused (`503 KILL_SWITCH`) until released with
  `{"engaged":false}`. This switch is in process memory, so a restart
  releases it.
- `AGENT_DISABLED=true`: durable off switch. It can't be released from the
  UI.
- `HARNESS_ADMINS=alice,bob`: only these users (from the auth proxy's
  `x-harness-user`) may engage or release it. Unset means anyone.
- `GET /api/admin/kill-switch` lists active runs.

## Guardrails (`lib/llm/guardrails.ts`)

Cheap, deterministic checks (regexes and counters) at the three points
where the loop meets the outside world:

- **Input:** a request containing a credential (AWS/GitHub/Anthropic/OpenAI/
  Slack keys, Adobe `p8e-` client secrets, JWTs, private keys,
  `password=…`) is refused with 400. Personal data follows
  `INPUT_PII_MODE`. Instruction-override phrasing is logged.
- **Actions:** each run may make at most `MAX_WRITES_PER_RUN` (default 25)
  write/destructive calls. Writes whose arguments name an id in
  `PROTECTED_RESOURCE_IDS` (exact, case-insensitive string match) are
  blocked. Credentials are redacted from tool results before the model
  sees them. Results containing instruction-like text get a
  `_guardrailWarning` telling the model not to follow it.
- **Output:** credentials are redacted from streamed steps, approval
  requests, the final answer, errors and persisted runs. Personal data is
  masked there too when `OUTPUT_PII_MODE=mask`.

| Variable | Default | Values |
| --- | --- | --- |
| `INPUT_PII_MODE` | `allow` | `allow`, `mask`, `block` (emails, US SSNs, Luhn-valid card numbers, phone numbers) |
| `OUTPUT_PII_MODE` | `allow` | `allow`, `mask` |
| `MAX_WRITES_PER_RUN` | `25` | positive integer |
| `PROTECTED_RESOURCE_IDS` | none | comma-separated ids |

`PROTECTED_RESOURCE_IDS` only sees ids that appear in the arguments. A
tool that falls back to a server-side default sandbox isn't caught.

## Write safety and read caching (`lib/llm/tool-call-cache.ts`)

- **No ambiguous write retries:** a write or destructive call is retried
  only after an error that shows the server refused it (429, 503,
  throttling, refused connection). After a timeout or other 5xx the change
  may already have been applied, so the model gets an error telling it to
  check the current state first.
- **Per-run de-duplication:** an identical write (same tool, same
  arguments) that already succeeded in the run isn't sent again. The model
  gets the earlier result back.
- **Read cache:** identical reads share a result for `READ_CACHE_TTL_MS`
  (default `60000`; `0` disables it). The cache is process-wide and any
  write clears it. Credential/secret reads are never cached.

## Durable runs (`lib/run-jobs.ts`, `lib/build-run.ts`)

Runs are jobs, not HTTP requests:

- **Detached:** `POST /api/build` starts the run and streams its events,
  but closing the tab or losing the connection doesn't stop it. The page
  reconnects automatically. `/?run=<id>` attaches to a live run, and
  `GET /api/runs/:id/events?after=<seq>` replays the buffered events and
  then streams live ones.
- **Explicit stop:** the Stop button calls `POST /api/runs/:id/cancel`; the
  kill switch still stops everything.
- **Checkpoints:** the run record is saved as `running` after every step.
  On startup, `instrumentation.ts` marks runs left `running` by the
  previous process as `interrupted`.
- **Resume:** interrupted and failed runs show **Resume** on
  `/results/[id]` (`POST /api/runs/:id/resume`). This starts a new run with
  the same request plus what the earlier attempt already did, told not to
  repeat completed changes (continuation by context, not by replaying the
  model's exact messages).
- Finished runs stay reconnectable for 15 minutes, then only the saved
  record remains.

This assumes a single Node process (like approvals and the kill switch).
Running several app instances needs a shared queue and event store (e.g.
Postgres or Redis) behind the same interfaces.

## Execution history / replay (lib/execution-store.ts)

Every `/api/build` run (success or failure) is persisted so it can be
listed and replayed from `/results`. Storage is a `harness_agent_runs`
table in the MCP server's own database, written via the `execute_sql` MCP
tool (full read/write/DDL access) over the same `MCP_ENDPOINT_URL`
connection already configured above — no separate database credentials or
setup needed. The table (and its index) is created automatically on first
use if it doesn't already exist.

This is a table dedicated to the harness. `allow_full_build`/`execution_id`
are retained columns from when the harness could opt into a full
end-to-end build tool; that tool isn't in the connected MCP server's
catalog (verified against its live tools/list, Aug 2026), so both columns
are now always `false`/`NULL` on new rows.

---

## Optional Variables

### `NEXT_PUBLIC_API_URL` (OPTIONAL)

**What it is**: Public URL for your harness API (used by frontend)

**Default value**: `http://localhost:3000` (development)

**Use cases**:
- **Local development**: `http://localhost:3000`
- **Staging**: `https://staging-harness.example.com`
- **Production**: `https://harness.example.com`

**Example**:
```
NEXT_PUBLIC_API_URL=https://harness.example.com
```

**Note**: Variables prefixed with `NEXT_PUBLIC_` are exposed to the browser

---

## Setup Instructions

### Local Development

Create `.env.local` in the project root:

```bash
cat > .env.local << 'EOF'
# Required: Get from MCP SAM deployment
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp

# Optional: API URL (defaults to http://localhost:3000)
NEXT_PUBLIC_API_URL=http://localhost:3000
EOF
```

### Vercel Deployment

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project
3. Go to **Settings** → **Environment Variables**
4. Add variable:
   - **Name**: `MCP_ENDPOINT_URL`
   - **Value**: `https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp`
   - **Environments**: Select Production (or all)
5. Click "Save"
6. Trigger new deployment (or push to git)

### EC2 Deployment

Create `.env.local` on your server:

```bash
ssh -i your-key.pem ubuntu@your-instance-ip

cd NEXT_HARNESS

cat > .env.local << 'EOF'
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
NEXT_PUBLIC_API_URL=https://your-domain.com
EOF

npm run build
npm run start
```

### Docker Deployment

Pass environment variables when running:

```bash
docker run -p 3000:3000 \
  -e MCP_ENDPOINT_URL="https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp" \
  -e NEXT_PUBLIC_API_URL="https://harness.example.com" \
  mcp-harness:latest
```

Or in docker-compose.yml:

```yaml
version: '3'
services:
  harness:
    image: mcp-harness:latest
    ports:
      - "3000:3000"
    environment:
      MCP_ENDPOINT_URL: https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
      NEXT_PUBLIC_API_URL: https://harness.example.com
```

### Self-Hosted Deployment

Create `.env.local`:

```bash
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
NEXT_PUBLIC_API_URL=https://your-domain.com
```

Then start:

```bash
npm install
npm run build
npm run start
```

---

## Verifying Configuration

### Test MCP Connection

```bash
# Verify endpoint is accessible
curl -X POST https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test","method":"tools/list"}'

# Should return a list of MCP tools
```

### Test Harness Locally

```bash
# Start development server
npm run dev

# In another terminal, test the build endpoint
curl -X POST http://localhost:3000/api/build \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Create an XDM schema for ecommerce purchase events"
  }'

# Should return a runId, the step-by-step tool-call trace, and finishReason
```

---

## Troubleshooting

### "MCP_ENDPOINT_URL is not set"

**Problem**: Environment variable not configured

**Solution**:
1. Create `.env.local` in project root
2. Add: `MCP_ENDPOINT_URL=https://...`
3. Restart dev server: `npm run dev`

### "Cannot connect to MCP"

**Problem**: Endpoint URL is wrong or MCP is offline

**Solutions**:
1. Verify endpoint URL from SAM outputs
2. Check MCP Lambda is deployed: `aws lambda list-functions`
3. Test endpoint with curl (see Verifying Configuration)
4. Check API Gateway is deployed: `aws apigateway get-rest-apis`

### "NetworkError when attempting to fetch"

**Problem**: CORS or network issues

**Solutions**:
1. Verify endpoint URL is correct
2. Check security groups allow HTTPS (port 443)
3. Try from different network
4. Check CloudWatch logs for Lambda errors

### Staging vs Production Using Different Endpoints

Use environment-specific variables:

**.env.local** (local development):
```
MCP_ENDPOINT_URL=https://dev-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

**.env.staging**:
```
MCP_ENDPOINT_URL=https://staging-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

**.env.production**:
```
MCP_ENDPOINT_URL=https://prod-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

Then load with: `next build --env-file=.env.production`

---

## Environment Variables Reference

| Variable | Required | Type | Example |
|----------|----------|------|---------|
| `MCP_ENDPOINT_URL` | ✅ Yes | URL | `https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp` |
| `GITHUB_TOKEN` | ❌ No | string | `github_pat_...` (enables github_read_file/github_list_directory) |
| `ANTHROPIC_API_KEY` | Only for `anthropic:*` entries | string | `sk-ant-...` |
| `DEFAULT_MODEL` | ❌ No | string | `bedrock:balanced` (default) |
| `BEDROCK_CHEAP_MODEL_ID` / `_BALANCED_` / `_EXPENSIVE_` | ❌ No | string | `anthropic.claude-haiku-4-5-20251001-v1:0` |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | For Bedrock entries | string | — |
| `OPENAI_API_KEY` | For OpenAI entries | string | `sk-...` |
| `OPENAI_CHEAP_MODEL_ID` / `_BALANCED_` / `_EXPENSIVE_` | ❌ No | string | `gpt-4o-mini` |
| `MODEL_REGISTRY_JSON` | ❌ No | JSON array | see LLM Provider Variables section |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL_ID` | ❌ No | string | `openai` / `text-embedding-3-small` |
| `NEXT_PUBLIC_API_URL` | ❌ No | URL | `https://harness.example.com` |

---

## Security Best Practices

✅ **DO**:
- Store `.env.local` in `.gitignore` (already configured)
- Use environment-specific configs (dev, staging, prod)
- Rotate endpoints if leaked
- Use HTTPS only
- Monitor API Gateway access logs

❌ **DON'T**:
- Commit `.env.local` to git
- Hardcode endpoints in code
- Share endpoints publicly
- Use HTTP (insecure)
- Expose endpoint in client-side code

---

## Getting Help

If you're stuck finding your MCP endpoint:

1. **Check AWS Console**:
   - Go to CloudFormation
   - Find stack named `mcp`
   - Click "Outputs" tab
   - Look for `McpEndpointUrl`

2. **Use AWS CLI**:
   ```bash
   aws cloudformation describe-stacks --stack-name mcp --query 'Stacks[0].Outputs'
   ```

3. **Check SAM logs**:
   ```bash
   sam logs --stack-name mcp --tail
   ```

4. **Verify Lambda is running**:
   ```bash
   aws lambda list-functions --query 'Functions[?contains(FunctionName, `mcp`)]'
   ```

5. **Test API Gateway**:
   ```bash
   aws apigateway get-rest-apis
   ```

---

## Quick Reference

### Minimal Setup (Local Development)

```bash
# 1. Create .env.local
echo "MCP_ENDPOINT_URL=https://your-endpoint/mcp" > .env.local

# 2. Install dependencies
npm install

# 3. Run development server
npm run dev

# 4. Open http://localhost:3000
```

### Production Setup (Vercel)

```bash
# 1. Push to GitHub
git push origin main

# 2. On Vercel Dashboard:
#    - Go to Settings → Environment Variables
#    - Add MCP_ENDPOINT_URL
#    - Deploy

# 3. Application live at your-project.vercel.app
```

### Docker Quick Setup

```bash
docker run -p 3000:3000 \
  -e MCP_ENDPOINT_URL="https://your-endpoint/mcp" \
  mcp-harness:latest
```

---

## Advanced Configuration

### Multiple MCP Endpoints (A/B Testing)

```bash
# .env.local
MCP_ENDPOINT_URL=https://primary-endpoint/mcp
MCP_ENDPOINT_URL_FALLBACK=https://fallback-endpoint/mcp
```

Then update `lib/mcp-client.ts` to use fallback on failure.

### Custom API Base Path

```bash
# If your API isn't at /api
NEXT_PUBLIC_API_BASE=/v1/api
```

### Development vs Production

Use `.env.development` and `.env.production`:

**.env.development**:
```
MCP_ENDPOINT_URL=https://localhost:3001/mcp
NODE_ENV=development
```

**.env.production**:
```
MCP_ENDPOINT_URL=https://api.example.com/mcp
NODE_ENV=production
```

---

That's it! Just set `MCP_ENDPOINT_URL` and you're good to go. 🚀

## Eval Variables

Only read by `npm run eval:*` (see `evals/README.md`), never by the app.

```bash
EVAL_MODEL=bedrock:cheap          # model under test for eval:agent; defaults to DEFAULT_MODEL
EVAL_JUDGE_MODEL=bedrock:expensive # grades rubric questions; defaults to the strongest tier of DEFAULT_MODEL's provider
EVAL_JUDGE_FALLBACK_MODEL=anthropic:opus  # retried when the judge refuses (safety filter); defaults to next-strongest on the same provider
EVAL_TRIALS=5                     # runs per fixture, for pass@k / pass^k (default 1, max 20)
MODEL_PRICING_JSON='{"bedrock:balanced":{"input":2,"output":10}}'
                                  # USD per 1M tokens, by registry key or model id; overrides the
                                  # Anthropic list prices in lib/llm/pricing.ts (Bedrock bills separately)
```

`eval:shortlist` needs `MCP_ENDPOINT_URL`; `eval:rag-judge` uses
`RAG_JUDGE_MODEL`/`RAG_JUDGE_ENABLED` exactly as the app does. Results are
saved via `MCP_ENDPOINT_URL` too (best-effort).
