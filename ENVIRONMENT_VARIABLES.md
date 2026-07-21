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

### `HARNESS_STATE_MACHINE_ARN` (REQUIRED for the default async path)

**What it is**: ARN of the `harness-agent-loop` Step Functions state machine
(`aws/`) that now runs the agent loop. `POST /api/build` starts one
execution of it and returns immediately (`202 { runId, status: 'PENDING' }`)
instead of running `lib/llm/agent.ts`'s loop in-process — see
`lib/step-functions-client.ts` and `aws/README.md` for how to deploy it.

**Where to get it**: the `StateMachineArn` output of `sam deploy` in `aws/`.

**Format**:
```
HARNESS_STATE_MACHINE_ARN=arn:aws:states:<region>:<account-id>:stateMachine:<stack-name>-harness-agent-loop
```

Wait — deployed name is `harness-agent-loop` regardless of stack name (see
`aws/template.yaml`'s `HarnessAgentLoopStateMachine.Properties.Name`), so
the ARN's last segment is literally `harness-agent-loop`, not stack-prefixed.

**Used by**: `lib/step-functions-client.ts` (`StartExecution`,
`SendTaskSuccess`, `SendTaskFailure`), using the same AWS credentials
configured below for Bedrock — that IAM principal additionally needs the
permissions in `aws/template.yaml`'s `NextJsControlPlanePolicy` (attach that
managed policy directly, or copy its statements onto whatever IAM user/role
this app authenticates as).

**Bypass**: append `?sync=1` to a `POST /api/build` request to skip Step
Functions entirely and run the whole agent loop in-process instead (the
original behavior) — kept only for side-by-side comparison during the
Step Functions cutover; doesn't require this variable at all.

**What happens if missing** (default async path only):
```
Error: HARNESS_STATE_MACHINE_ARN is not set. Deploy aws/ (see aws/README.md)
and set the StateMachineArn output in .env.local.
```

---

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
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...   # only if using temporary credentials
```

### `DEFAULT_MODEL` (optional)

Registry key used when a build request doesn't specify `model`. Defaults to
`bedrock:balanced`. Example: `DEFAULT_MODEL=bedrock:cheap` to default to
the cheapest option, or `DEFAULT_MODEL=anthropic:sonnet` to default to
Anthropic direct instead.

### `ANTHROPIC_API_KEY` (optional — only for the `anthropic:*` entries)

Used by the `anthropic:haiku` / `anthropic:sonnet` / `anthropic:opus`
registry entries, which are still available as an alternative to Bedrock
but are not the default and are not required to run the harness.

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

---

## Execution history / replay (lib/execution-store.ts)

Every `/api/build` run (success or failure) is persisted so it can be
listed and replayed from `/results`. Storage is a `harness_agent_runs`
table in the MCP server's own database, written via the `execute_sql` MCP
tool (full read/write/DDL access) over the same `MCP_ENDPOINT_URL`
connection already configured above — no separate database credentials or
setup needed. The table (and its index) is created automatically on first
use if it doesn't already exist.

This is a table dedicated to the harness, separate from the orchestrator's
own `executions` / `execution_resources` / `tool_invocations` tables
(applied by `msb_run_migration`) — those track `msb_execute_solution`'s
internal phase state with a different schema and are owned by the Python
backend.

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
    "description": "Build an AEP solution for ecommerce"
  }'

# Should return:
# {"execution_id":"exec-xxx","status":"QUEUED","message":"..."}
```

### Test Status Polling

```bash
# Replace exec-xxx with actual execution_id
curl http://localhost:3000/api/executions/exec-xxx/status

# Should return:
# {"execution_id":"exec-xxx","status":"RUNNING","progress":0.25,...}
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
| `HARNESS_STATE_MACHINE_ARN` | ✅ Yes (unless every request uses `?sync=1`) | ARN | `arn:aws:states:us-east-1:123456789012:stateMachine:harness-agent-loop` |
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
