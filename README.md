This is the web harness for an Adobe Experience Cloud MCP server (schemas,
schema registry classes/field groups/data types/descriptors, batch
ingestion, real-time customer profile, sandbox management, identity
namespaces, privacy jobs, segments plus segment/export/estimate jobs,
Flow Service sources and destinations (including flow specs, landing
zone, and pause/resume), the Data Prep mapping-set API, CJA,
Reactor/Launch, and a solutions-architecture knowledge base that also
covers AJO — though there are no dedicated AJO journey/offer tools yet).
The catalog is filtered to Adobe-scoped tools by default
(`ADOBE_TOOLS_ONLY`, see [Tool scope](#tool-scope)) — AWS/Databricks/Snowflake support is
defined in the harness's tool-catalog filtering code but isn't currently
present in the connected MCP server's tool list.

`POST /api/build` runs a dynamic agent (`lib/llm/agent.ts`) rather than a
fixed pipeline: it semantically shortlists the handful of MCP tools relevant
to your request (`lib/llm/tool-retrieval.ts`), then lets an LLM call them in
a loop until the task is done. The model is swappable per request across
Anthropic, Bedrock, or OpenAI (`lib/llm/model-registry.ts`) — pick cheap vs.
expensive, or switch providers, without code changes. There is no full,
end-to-end build tool wired up — every request resolves through specific,
narrow tool calls chosen by the agent. Every run's chat-model token usage
is tracked and shown in the agent trace and in `/results`, so cost per
request is visible, not just inferred from the model tier picked.

See `ENVIRONMENT_VARIABLES.md` for the required `MCP_ENDPOINT_URL` and the
LLM provider variables that control which models are available. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for a diagram of how the harness,
the MCP server, and the platforms behind it fit together.

## Orchestrator-worker mode

When a run has a plan with independent steps, a deterministic coordinator
(`lib/llm/coordinator.ts`) can run them as concurrent worker agents
(`lib/llm/worker.ts`), replan once a step fails, and make one synthesis call
for the final answer. It's off by default: set `ORCHESTRATION=on` and tick
**Run steps in parallel** on the home page (or send `"orchestrate": true`),
or set `ORCHESTRATION=always`. A process-wide slot pool
(`lib/llm/agent-slots.ts`) caps how many agent loops run at once. See the
orchestrator-worker section of `ENVIRONMENT_VARIABLES.md` for the limits.

## Tool scope

`ADOBE_TOOLS_ONLY` (default `true`) drops non-Adobe tools (AWS, Databricks,
Snowflake and the like) from the catalog before the agent sees it; GitHub's
`msb_github_*` tools are always kept. Set `ADOBE_TOOLS_ONLY=false` to bring
the others back. `BUILD_POLICY=read-only` and `TOOL_DRY_RUN=true` restrict
what the agent can change; see `ENVIRONMENT_VARIABLES.md`.

## Access

The harness has **no built-in authentication**: anyone who can reach it can
run the agent with the MCP server's Adobe and GitHub credentials. Run it on
a private network or behind an authenticating proxy. `HARNESS_APPROVERS` and
`HARNESS_ADMINS` match the `x-harness-user` header, so they only restrict
anything when that proxy sets the header.

## Getting Started

```bash
cp .env.local.example .env.local   # set MCP_ENDPOINT_URL and a chat-model provider
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), describe what you want,
and watch the agent trace.

## Docker

The app and the eval suite both run under Docker Compose. Configuration
comes from the same `.env.local` that `npm run dev` reads (copy
`.env.local.example`). It's injected when a container starts and never
copied into an image; `.dockerignore` keeps every `.env*` file out of the
build.

```bash
docker compose up -d --build                     # the app on http://localhost:3000
docker compose logs -f app
docker compose ps                                # shows "healthy" once /api/models answers

docker compose run --rm --build evals            # npm run eval:all
docker compose run --rm evals eval:judge         # one suite
docker compose run --rm -e EVAL_TRIALS=5 evals   # per-run overrides

docker compose down
```

- **Images.** `Dockerfile` is multi-stage. `runner` is the app, built with
  Next's `output: "standalone"` (a minimal `server.js` and only the traced
  `node_modules`), running as a non-root user and healthchecked on
  `GET /api/models`, which makes no MCP or model calls. `evals` is the full
  source plus dev dependencies for vitest. It only runs on demand (compose
  profile `evals`), never with `up`.
- **Port.** Set `HARNESS_PORT=8080` to publish on a different host port.
- **Config changes** need a restart, not a rebuild:
  `docker compose up -d --force-recreate app`. Code changes need
  `--build`.
- **Bedrock with an EC2 instance role instead of keys:** containers reach
  the instance metadata service only if its IMDSv2 hop limit is at least 2
  (`aws ec2 modify-instance-metadata-options --instance-id <id>
  --http-put-response-hop-limit 2`). The Claude API
  (`ANTHROPIC_API_KEY` + `DEFAULT_MODEL=anthropic:…`) needs nothing extra.

## Testing

```bash
npm run test        # run the suite once (vitest)
npm run test:watch  # re-run on file changes
```

Unit tests sit next to the code as `*.test.ts` (in `lib/`, `app/api/` and
`evals/lib/`): the agent loop and its budgets, tool catalog filtering and
retries, tool policy and approvals, guardrails, the planner, the
orchestration coordinator and workers, Launch validation, run jobs and
storage, tracing, and the eval graders. They stub the model, the MCP server
and the embedding provider, so they need no credentials. CI
(`.github/workflows/ci.yml`) runs them with typecheck, lint and build on
every PR.

## Evals

```bash
npm run eval:shortlist   # does tool shortlisting surface the right tools? (live MCP catalog)
npm run eval:agent       # does the real agent loop behave? (real model, scripted tools)
npm run eval:launch      # does Launch mode produce rules/data elements that validate?
npm run eval:routing     # does "auto" model routing pick the right tier?
npm run eval:rag-judge   # does the RAG judge agree with a human?
npm run eval:judge       # does the eval's own rubric judge agree with a human?
npm run eval:critic      # does the answer critic agree with a human?
npm run eval:all
EVAL_TRIALS=5 npm run eval:agent   # repeat each case to measure pass@k / pass^k
```

Separate from `npm test`: evals call the real, configured model / embedding
provider / MCP endpoint against hand-reviewed fixtures in `evals/fixtures/`,
so they cost money and aren't deterministic. The agent suite includes
safety cases (prompt injection, credential exfiltration, ambiguous
destructive requests). Each run reports success rate, pass@k/pass^k,
tool-call accuracy, safety violation rate, steps, p50/p95 latency and cost
per success, prints them as a table, and saves them to the MCP server's
database, browsable at `/evals`. See
[`evals/README.md`](./evals/README.md) for what each suite checks and how to
add fixtures.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md): how the harness, the MCP server and the platforms fit together
- [`ENVIRONMENT_VARIABLES.md`](./ENVIRONMENT_VARIABLES.md): every setting the app reads
- [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md): EC2, Docker and other deployments, plus known gotchas
- [`OPERATIONS.md`](./OPERATIONS.md): the weekly habits that keep the agent good in production
- [`evals/README.md`](./evals/README.md): the eval suites and how to add fixtures
- [`docs/reactor-tools-context.md`](./docs/reactor-tools-context.md): full reference for the Reactor/Launch tools (a compact version is injected in Launch mode)
- `.kiro/`: product/tech steering and the orchestrator-workers spec
