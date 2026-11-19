# Structure

```
app/                      Next.js App Router
  page.tsx                Main page: request form, live trace, approvals
  api/build/route.ts      POST: start a run, stream NDJSON events
  api/build/approve/      POST: approve or deny a pending tool call / plan
  api/runs/[id]/          Run record, events (reconnect), cancel, resume, feedback
  api/admin/kill-switch/  Trip / reset the kill switch
  api/evals, metrics, audit, memory, models, tools
  results/, evals/, metrics/, memory/   UI pages
components/               React components (AgentTrace, PlanView, KillSwitch, ...)
lib/
  start-run.ts            Starts a run as a job: kill switch, agent, events, checkpoints, critic, judge
  run-jobs.ts             Detached jobs and event buffers (in-process)
  run-lifecycle.ts        Run statuses and allowed moves: running ⇄ awaiting_approval → completed | failed | cancelled | interrupted
  run-store.ts            Run records in harness_agent_runs via execute_sql
  kill-switch.ts, audit-log.ts, memory-store.ts, online-judge.ts, tracing.ts
  mcp-client.ts, mcp-sql.ts   MCP transport and SQL escaping
  types/                  Shared types, one module per concept (run, stream, agent, worker, plan,
                          quality, model, eval, api); types only. …Record = stored, …Summary = list row
  llm/
    runtime/              The agent loop and orchestration
      agent.ts            runAgent = prepareRun + executeLoop; the public entry point
      prepare-run.ts      Setup: routing, Launch mode, tool selection, memory, planning, approvals
      agent-loop.ts       executeLoop: the streamText model/tool loop
      agent-options.ts    RunAgentOptions / AgentRunResult
      provider-options.ts Prompt-cache markers, context editing, extended thinking
      context-compression.ts, tool-selection.ts, step-trace.ts
      agent-core.ts       System prompt pieces and shared agent types
      planner.ts          Plan, PlanTracker, update_plan / revise_plan tools
      planning-retrieval.ts  Knowledge-base context for the planner
      coordinator.ts      Orchestrator: runs independent plan steps as concurrent workers, replans, synthesises
      worker.ts           One worker agent loop for a plan step, with a narrowed tool set
      agent-slots.ts      Process-wide cap on concurrent agent loops
      run-budget.ts       Token / cost / time budgets and loop detection
      orchestration-config.ts  ORCHESTRATION / MAX_WORKERS / ... env readers
    tools/                The MCP tool layer
      tool-taxonomy.ts    Every hand-kept tool fact: access level, outbound/credential/SQL sets, platform groups, scope
      tool-registry.ts    describeTool(name): one profile per tool (also GET /api/tools)
      tool-catalog.ts     MCP catalog, PLATFORM_GROUPS, AI SDK tool wrappers, retries
      tool-retrieval.ts, tool-discovery.ts, tool-policy.ts, tool-call-cache.ts
      approval-policy.ts, approvals.ts   Which calls need a person, and the waiting room
      local-tools.ts, retrieval-hints.ts
    models/               model-registry.ts, model-router.ts ("auto" routing), model-health.ts, pricing.ts, embeddings.ts
    quality/              answer-critic.ts, rag-judge.ts, guardrails.ts, commit-validation.ts
    domains/              Adobe domain knowledge, kept apart from the generic agent machinery
      domain-pack.ts      DomainPack interface: detect, promptContext, alwaysOnTools, plus optional
                          startSession (gate, seeded plan, preamble, approvals), checkToolCall, localTools
      index.ts            DOMAIN_PACKS registry. runtime/ and tools/ reach domains only through it
      launch/             Launch (Reactor): pack, prompt context, brief parsing, plan template, examples, validation gate
      segments/           Audiences: pack, PQL reference, glossary, profile catalog, field check
evals/                    vitest eval suites, fixtures, baseline.json
scripts/                  Eval baseline check, run-to-fixture
.kiro/specs/              Kiro feature specs (requirements, design, tasks)
```

Unit tests live next to the module they cover as `*.test.ts`.

Layer rules (enforced by `npm run lint`, see eslint.config.mjs): `models/` imports no
other layer; `tools/` never imports `runtime/`; `quality/` uses only the pure
tool taxonomy; `domains/` packs never import each other and use only the
planner from `runtime/`; everything outside `domains/` reaches a domain only
through `lib/llm/domains` (the registry). Type-only imports are allowed, and
`import/no-cycle` forbids import cycles.
