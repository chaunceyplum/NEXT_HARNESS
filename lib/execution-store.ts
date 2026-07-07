/**
 * Execution Store
 *
 * In-memory store for harness-driven executions. The harness itself now owns
 * "execute solution" — there is no MCP orchestrator tool (msb_execute_solution
 * exists but cannot be safely invoked over JSON-RPC and is bound by a 30s
 * Lambda timeout; see PR notes). Instead, the harness runs an ordered plan of
 * individual, already-working AEP / CJA / AJO / RAG tool calls and tracks
 * their progress here.
 *
 * IMPORTANT DEPLOYMENT NOTE:
 * This store is a process-local `Map`. It only works correctly when the
 * harness runs as a single, persistent Node.js process (e.g. `next start`
 * on EC2/Docker/self-hosted, per DEPLOYMENT_GUIDE.md). It will NOT work
 * correctly on multi-instance or serverless deployments (e.g. Vercel
 * functions), where each request may hit a different process/instance and
 * in-flight background work can be frozen after the response is sent.
 * If you need a serverless-safe deployment, this store must be swapped for
 * a shared backing store (e.g. Postgres/Redis) — out of scope for this fix.
 */

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepRecord {
  id: string;
  label: string;
  tool: string;
  category: 'rag' | 'aep' | 'launch' | 'cja' | 'ajo';
  critical: boolean;
  status: StepStatus;
  args?: Record<string, any>;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ExecutionStatus =
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface ExecutionRecord {
  id: string;
  description: string;
  solutionConfig: Record<string, any>;
  status: ExecutionStatus;
  steps: StepRecord[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// Module-level singleton map — survives across requests within one process.
const executions = new Map<string, ExecutionRecord>();

export function createExecution(
  id: string,
  description: string,
  solutionConfig: Record<string, any>,
  steps: Omit<StepRecord, 'status'>[]
): ExecutionRecord {
  const now = new Date().toISOString();
  const record: ExecutionRecord = {
    id,
    description,
    solutionConfig,
    status: 'running',
    steps: steps.map((s) => ({ ...s, status: 'pending' as StepStatus })),
    createdAt: now,
    updatedAt: now,
  };
  executions.set(id, record);
  return record;
}

export function getExecution(id: string): ExecutionRecord | undefined {
  return executions.get(id);
}

/**
 * List all known executions, most recently created first.
 *
 * Subject to the same process-local caveat as the rest of this store (see
 * file header) — this only reflects executions created in the current
 * process since it last started.
 */
export function listExecutions(): ExecutionRecord[] {
  return Array.from(executions.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function updateStep(
  executionId: string,
  stepId: string,
  patch: Partial<StepRecord>
): void {
  const record = executions.get(executionId);
  if (!record) return;
  const step = record.steps.find((s) => s.id === stepId);
  if (!step) return;
  Object.assign(step, patch);
  record.updatedAt = new Date().toISOString();
}

export function setExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
  error?: string
): void {
  const record = executions.get(executionId);
  if (!record) return;
  record.status = status;
  if (error) record.error = error;
  record.updatedAt = new Date().toISOString();
}

export function computeProgress(record: ExecutionRecord): number {
  if (record.steps.length === 0) return 0;
  const finished = record.steps.filter(
    (s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  ).length;
  return finished / record.steps.length;
}

export function currentStepLabel(record: ExecutionRecord): string | null {
  const running = record.steps.find((s) => s.status === 'running');
  if (running) return running.label;
  const nextPending = record.steps.find((s) => s.status === 'pending');
  if (nextPending) return nextPending.label;
  return null;
}
