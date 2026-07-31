/**
 * Error taxonomy the ASL Retry/Catch blocks match on by name
 * (aws/statemachine/harness-agent-loop.asl.json). Distinct from
 * lib/llm/agent-core.ts's stage() helper, which tags error *messages* for
 * human readability but always rethrows a plain Error — these instead
 * rename the error so Step Functions can route retries: model-provider
 * hiccups get backed-off retries, state-store (Postgres via execute_sql)
 * hiccups get a few quick retries, and everything else (a real tool
 * failure, a bug) fails the state immediately into the Catch block.
 */

export class ModelProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelProviderError';
  }
}

export class StateStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateStoreError';
  }
}

export async function asModelProviderError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ModelProviderError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

export async function asStateStoreError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new StateStoreError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}
