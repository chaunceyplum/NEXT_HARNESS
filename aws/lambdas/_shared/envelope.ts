/**
 * Control envelope passed between Step Functions states. Kept deliberately
 * tiny — Standard workflows cap inter-state payload at 256KB, and a
 * multi-step agent conversation's messages would blow past that fast. Every
 * Lambda loads/saves the real state (messages, tool calls, etc.) from
 * harness_agent_runs via lib/execution-store.ts instead of passing it
 * through here. See aws/statemachine/harness-agent-loop.asl.json.
 */
export interface LoopEnvelope {
  runId: string;
  stepCount: number;
  status: 'TOOL_CALLS' | 'NEEDS_APPROVAL' | 'DONE' | 'MAX_STEPS';
  maxSteps: number;
}
