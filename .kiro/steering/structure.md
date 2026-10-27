# Structure

```
app/                      Next.js App Router
  page.tsx                Main page: request form, live trace, approvals
  api/build/route.ts      POST: start a run, stream NDJSON events
  api/build/approve/      POST: approve or deny a pending tool call / plan
  api/runs/[id]/          Run record, events (reconnect), cancel, resume, feedback
  api/admin/kill-switch/  Trip / reset the kill switch
  api/evals, metrics, audit, memory, models
  results/, evals/, metrics/, memory/   UI pages
components/               React components (AgentTrace, PlanView, KillSwitch, ...)
lib/
  build-run.ts            Starts a run as a job: kill switch, agent, events, checkpoints, critic, judge
  run-jobs.ts             Detached jobs and event buffers (in-process)
  execution-store.ts      Run records in harness_agent_runs via execute_sql
  kill-switch.ts, audit-log.ts, memory-store.ts, online-judge.ts, tracing.ts
  mcp-client.ts, mcp-sql.ts   MCP transport and SQL escaping
  types.ts                Shared DTOs: BuildRequest, BuildStreamEvent, ExecutionRecord, ...
  llm/
    agent.ts              runAgent: setup + the streamText tool loop
    agent-core.ts         System prompt pieces and shared agent types
    planner.ts            Plan, PlanTracker, update_plan / revise_plan tools
    model-router.ts       "auto" model routing
    model-registry.ts, model-health.ts, pricing.ts
    tool-catalog.ts       MCP catalog, PLATFORM_GROUPS, AI SDK tool wrappers, retries
    tool-retrieval.ts, tool-discovery.ts, tool-policy.ts, approval-policy.ts, approvals.ts
    run-budget.ts         Token / cost / time budgets and loop detection
    answer-critic.ts, rag-judge.ts, guardrails.ts
    launch-*.ts           Launch (Reactor) brief parsing, plan template, examples, validation gate
    coordinator.ts        Orchestrator: runs independent plan steps as concurrent workers, replans, synthesises
    worker.ts             One worker agent loop for a plan step, with a narrowed tool set
    agent-slots.ts        Process-wide cap on concurrent agent loops
    orchestration-config.ts  ORCHESTRATION / MAX_WORKERS / ... env readers
evals/                    vitest eval suites, fixtures, baseline.json
scripts/                  Eval baseline check, run-to-fixture
.kiro/specs/              Kiro feature specs (requirements, design, tasks)
```

Unit tests live next to the module they cover as `*.test.ts`.
