# Product

NEXT_HARNESS is a Next.js web app that runs an LLM agent against Adobe
Experience Cloud through an MCP server (the AEC MCP: AEP schemas, segments,
datasets, CJA, Reactor/Launch tags, data prep, destinations, query service).

A user describes what they want in plain English. The agent picks tools from
the MCP catalog, optionally plans first, and calls tools in a loop until it
can answer. Risky calls (destructive, outbound, credential reads, and every
write in assisted rollout mode) wait for a human approval in the UI.

Key behaviours to preserve:

- Runs are background jobs; a client can disconnect and reconnect to the
  event stream.
- Every run is checkpointed after each step and stored in the MCP server's
  database (`harness_agent_runs`), so it can be replayed and resumed.
- Launch-tagging runs stop at a populated library, or publish only to a
  development or staging environment. Production publishing is refused in
  code (`lib/llm/launch-validation.ts`).
- Budgets (tokens, cost, time, identical calls), the kill switch and the
  tool policy (`read-only`, dry-run, rollout modes) are enforced in code,
  never only in the prompt.
- Final answers are checked against tool results by the answer critic, and a
  sample of runs is scored by the online judge.
