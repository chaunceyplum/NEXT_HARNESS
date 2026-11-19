/** The plan as stored and streamed (lib/llm/runtime/planner.ts). */

export interface PlanRecord {
  goal: string;
  version: number;
  steps: Array<{
    id: number;
    description: string;
    tool: string | null;
    expectedOutput: string;
    dependsOn: number[];
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    note?: string;
    /** The worker running this step, when the run is orchestrated (Requirement 15.2). */
    workerId?: string;
  }>;
}
