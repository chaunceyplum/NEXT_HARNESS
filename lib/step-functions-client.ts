/**
 * Step Functions client for the harness-agent-loop control plane
 * (aws/ — see aws/README.md for what the state machine does). Next.js only
 * ever starts executions and resolves approval task tokens; all the
 * per-step work happens in the Lambdas (aws/lambdas/), which read/write
 * run state directly via lib/execution-store.ts.
 */

import {
  SFNClient,
  StartExecutionCommand,
  SendTaskSuccessCommand,
  SendTaskFailureCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';

const STATE_MACHINE_ARN = process.env.HARNESS_STATE_MACHINE_ARN;

let client: SFNClient | null = null;
function getClient(): SFNClient {
  if (!client) client = new SFNClient({ region: process.env.AWS_REGION });
  return client;
}

function requireStateMachineArn(): string {
  if (!STATE_MACHINE_ARN) {
    throw new Error(
      'HARNESS_STATE_MACHINE_ARN is not set. Deploy aws/ (see aws/README.md) and set the StateMachineArn output in .env.local.'
    );
  }
  return STATE_MACHINE_ARN;
}

export interface StartRunInput {
  runId: string;
  description: string;
  modelKey: string;
  allowFullBuild: boolean;
  maxSteps: number;
  toolShortlistSize: number;
  toolRetries: number;
}

/** Execution name = runId, so StartExecution's own idempotency (can't reuse a name) means the same runId can't accidentally start twice. */
export async function startRun(input: StartRunInput): Promise<string> {
  const result = await getClient().send(
    new StartExecutionCommand({
      stateMachineArn: requireStateMachineArn(),
      name: input.runId,
      input: JSON.stringify(input),
    })
  );
  if (!result.executionArn) {
    throw new Error(`StartExecution for run "${input.runId}" returned no executionArn`);
  }
  return result.executionArn;
}

/** Resolves a pending RequestApproval task — the workflow resumes into ExecTools. */
export async function approveTask(taskToken: string): Promise<void> {
  await getClient().send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify({ approved: true }) }));
}

/** Resolves a pending RequestApproval task as rejected — the workflow routes into InjectRejection with `feedback`. */
export async function rejectTask(taskToken: string, feedback: string): Promise<void> {
  await getClient().send(
    new SendTaskFailureCommand({ taskToken, error: 'HumanRejected', cause: JSON.stringify({ feedback }) })
  );
}

/** Not wired into any route yet — kept available (the IAM policy in aws/template.yaml already grants it) for future ops tooling / debugging a stuck execution. */
export async function describeRunExecution(executionArn: string) {
  return getClient().send(new DescribeExecutionCommand({ executionArn }));
}

/** Same as above — available, not yet exposed through an API route. */
export async function stopRunExecution(executionArn: string, cause?: string): Promise<void> {
  await getClient().send(new StopExecutionCommand({ executionArn, cause }));
}
