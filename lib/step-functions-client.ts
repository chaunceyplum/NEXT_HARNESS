/**
 * Step Functions client — runs one MCP tool call as one execution of the
 * tool-executor state machine (infra/step-functions/), instead of
 * lib/mcp-client.ts's bare HTTP call. Gets native retries (see the ASL's
 * Retry block), execution history, and cancel (StopExecution) for free.
 *
 * The state machine ARN comes from deploying infra/step-functions/ yourself
 * (see its README) — this file only ever talks to an already-deployed state
 * machine, it never creates one.
 */

import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  StopExecutionCommand,
  ExecutionStatus as SfnExecutionStatus,
} from '@aws-sdk/client-sfn';

const STATE_MACHINE_ARN = process.env.TOOL_EXECUTOR_STATE_MACHINE_ARN;

let client: SFNClient | null = null;
function getClient(): SFNClient {
  if (!client) client = new SFNClient({ region: process.env.AWS_REGION });
  return client;
}

function requireStateMachineArn(): string {
  if (!STATE_MACHINE_ARN) {
    throw new Error(
      'TOOL_EXECUTOR_STATE_MACHINE_ARN is not set. Deploy infra/step-functions/ (see its README) and set the StateMachineArn output in .env.local.'
    );
  }
  return STATE_MACHINE_ARN;
}

/** Step Functions execution names allow only [A-Za-z0-9-_], up to 80 chars. */
function sanitizeExecutionName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9\-_]/g, '-');
  return cleaned.slice(0, 80);
}

export interface ToolExecutionOutcome {
  executionArn: string;
  status: Exclude<SfnExecutionStatus, 'RUNNING'>;
  /** Present when status === 'SUCCEEDED' — the unwrapped MCP tool result. */
  output?: unknown;
  /** Present when the execution didn't succeed. */
  error?: string;
  cause?: string;
}

export interface RunToolOptions {
  /** Used to build a readable, unique execution name — e.g. the agent run id. */
  runId: string;
  /** Milliseconds between DescribeExecution polls. Default 750. */
  pollIntervalMs?: number;
  /** Give up waiting after this long (execution keeps running remotely). Default 5 minutes. */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start one execution for a single tool call. Returns immediately (does not wait). */
export async function startToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  runId: string
): Promise<string> {
  const name = sanitizeExecutionName(`${runId}-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const result = await getClient().send(
    new StartExecutionCommand({
      stateMachineArn: requireStateMachineArn(),
      name,
      input: JSON.stringify({ toolName, arguments: args }),
    })
  );

  if (!result.executionArn) {
    throw new Error(`StartExecution for tool "${toolName}" returned no executionArn`);
  }
  return result.executionArn;
}

/** Poll an execution to completion. Throws only on SDK/network failure, not tool failure (see ToolExecutionOutcome.status). */
export async function waitForToolExecution(
  executionArn: string,
  opts: Pick<RunToolOptions, 'pollIntervalMs' | 'timeoutMs'> = {}
): Promise<ToolExecutionOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const desc = await getClient().send(new DescribeExecutionCommand({ executionArn }));

    if (desc.status !== 'RUNNING') {
      if (desc.status === 'SUCCEEDED') {
        return {
          executionArn,
          status: 'SUCCEEDED',
          output: desc.output ? JSON.parse(desc.output) : undefined,
        };
      }
      // FAILED / TIMED_OUT / ABORTED — desc.error/desc.cause come from the ASL Fail state
      // (ErrorPath/CausePath), i.e. the Lambda's thrown error name + message.
      return {
        executionArn,
        status: desc.status as ToolExecutionOutcome['status'],
        error: desc.error,
        cause: desc.cause,
      };
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for Step Functions execution ${executionArn} (still RUNNING remotely — check the console or GetExecutionHistory).`
      );
    }
    await sleep(pollIntervalMs);
  }
}

/** Start + wait in one call — the common case for a single tool invocation. */
export async function runToolViaStepFunctions(
  toolName: string,
  args: Record<string, unknown>,
  opts: RunToolOptions
): Promise<ToolExecutionOutcome> {
  const executionArn = await startToolExecution(toolName, args, opts.runId);
  return waitForToolExecution(executionArn, opts);
}

export interface ExecutionHistoryEvent {
  id: number;
  timestamp: string;
  type: string;
  details?: unknown;
}

/** State-by-state transition history for one execution — powers the "view Step Functions history" panel in the UI. */
export async function getExecutionHistory(executionArn: string): Promise<ExecutionHistoryEvent[]> {
  const events: ExecutionHistoryEvent[] = [];
  let nextToken: string | undefined;

  do {
    const page = await getClient().send(
      new GetExecutionHistoryCommand({ executionArn, nextToken, includeExecutionData: true })
    );
    for (const e of page.events ?? []) {
      const { id, timestamp, type, ...rest } = e;
      events.push({
        id: id ?? 0,
        timestamp: timestamp ? new Date(timestamp).toISOString() : '',
        type: type ?? 'Unknown',
        details: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return events;
}

export async function stopExecution(executionArn: string, cause?: string): Promise<void> {
  await getClient().send(new StopExecutionCommand({ executionArn, cause }));
}
