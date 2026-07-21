# Tool-executor state machine

Runs a single MCP tool call (`{ toolName, arguments }`) as one Step Functions
execution: a Lambda invokes the MCP endpoint over the same JSON-RPC wire
format the Next.js harness already speaks (`lib/mcp-client.ts`), Step
Functions retries transient failures with backoff, and the execution's own
status/output/history stand in for the ad-hoc bookkeeping the harness used to
do by hand.

The Next.js agent loop (`lib/llm/agent.ts`) still decides *which* tool to call
and *when* — this only replaces how a chosen tool call is executed. See
`lib/step-functions-client.ts` and `lib/llm/tool-catalog.ts` for the caller
side.

## Deploy

```bash
cd infra/step-functions
sam build
sam deploy --guided
```

On first `--guided` deploy you'll be asked for:
- `McpEndpointUrl` — same value as the harness's `MCP_ENDPOINT_URL`
- `McpApiKey` / `McpAuthToken` — only if your MCP API Gateway stage requires them

Take the `StateMachineArn` from the stack outputs and set it in the harness's
`.env.local` as `TOOL_EXECUTOR_STATE_MACHINE_ARN`. The harness calls
`StartExecution`/`DescribeExecution`/`GetExecutionHistory`/`StopExecution`
directly via `@aws-sdk/client-sfn`, using the same AWS credentials it already
has configured for Bedrock (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
`AWS_REGION`) — that IAM principal additionally needs:

```
states:StartExecution
states:DescribeExecution
states:GetExecutionHistory
states:StopExecution
```

scoped to the deployed `ToolExecutorStateMachine` (and its execution ARNs).

## Redeploying after a change

`sam build && sam deploy` picks up changes to either
`lambda/mcp-tool-executor/index.mjs` or `statemachine/tool-executor.asl.json`.
No parameter re-entry needed unless a parameter value itself changed.

## Why per-tool-call executions instead of one execution per agent run

The agent loop's "which tool next" decision is made by an LLM call inside
Next.js, not by the state machine — Step Functions state machines are static
graphs and can't express "let a model pick." Modeling the *whole* dynamic
loop in ASL would mean a Lambda that itself calls the model in a loop, which
duplicates logic Next.js already has. Scoping each execution to one tool call
keeps the state machine simple while still buying durability, retries, and
observability for the part that actually talks to external systems (the tool
call itself).
