/** Eval history (lib/eval-store.ts, written by evals/lib/report.ts). */

export interface EvalRunMetrics {
  fixtures: number;
  /** Graded trials — errored trials excluded. */
  trials: number;
  /** Trials where the grader/infrastructure failed; excluded from all rates. */
  errored: number;
  /** Trials per fixture. The minimum across fixtures, if they ever differ. */
  k: number;
  successRate: number;
  passAtK: number;
  passHatK: number;
  /** Share of trials whose structural checks (tool choice, args, order, limits) passed. Undefined when no trial had them. */
  toolCallAccuracy?: number;
  /** Share of trials with at least one safety violation. Target is zero. */
  safetyViolationRate: number;
  safetyViolations: number;
  stepsMean?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  totalCostUsd?: number;
  costPerSuccessUsd?: number;
  tokensPerSuccess?: number;
}

/** Which eval suite a run came from — one per `npm run eval:*` file. */
export type EvalSuite =
  | 'agent'
  | 'launch'
  | 'tool_shortlist'
  | 'rag_judge'
  | 'judge_calibration'
  | 'critic_calibration'
  | 'routing'
  // Orchestrated-mode results of the agent/launch suites (EVAL_ORCHESTRATE),
  // kept as their own baseline keys so the regression gate tracks the
  // coordinator path separately from single-agent (Requirement 16.3).
  | 'agent_orchestrated'
  | 'launch_orchestrated';

export interface EvalRunSummary {
  id: string;
  suite: EvalSuite;
  /**
   * What was actually graded: a model registry key for the agent/RAG-judge/
   * judge-calibration suites, or the retrieval mode ("embeddings:openai",
   * "lexical-fallback") for the tool-shortlist suite.
   */
  subject: string;
  /** Model registry key that graded rubric questions, when any fixture needed one. */
  judgeModel?: string;
  /** Short hash of the agent system prompt that was graded, so a score can be tied to a prompt change. */
  promptVersion?: string;
  /** Passed trials / all trials (with k trials per fixture, total = fixtures × k). */
  passedCount: number;
  totalCount: number;
  /** Trials per fixture (EVAL_TRIALS). */
  trialsPerFixture: number;
  /** Computed by lib/eval-metrics.ts at save time. Absent on runs saved before metrics existed. */
  metrics?: EvalRunMetrics;
  startedAt: string;
  finishedAt: string;
}

/** One trial of one fixture. */
export interface EvalTrialRecord {
  fixtureId: string;
  /** 1-based trial number within the run. */
  trial: number;
  passed: boolean;
  /**
   * The grader or the infrastructure failed, not the thing being graded: the
   * judge refused and so did its fallback, a provider call threw mid-run. An
   * errored trial is always `passed: false`, but it is excluded from every
   * rate so a flaky judge can't masquerade as a bad agent.
   */
  errored?: boolean;
  /** Why — the mismatch detail, a judge's per-criterion scores, a recall breakdown. */
  notes: string;
  /** Fixture category, e.g. "safety". */
  category?: string;
  /** Whether the deterministic checks (tools, args, order, limits) passed, independent of the judge. */
  structuralPassed?: boolean;
  /** The agent made a call a fixture marks unsafe (e.g. followed an injected instruction). */
  safetyViolation?: boolean;
  durationMs?: number;
  /** Chat-model tokens spent on this trial (agent suite only). */
  totalTokens?: number;
  /** Estimated USD at list price (lib/llm/models/pricing.ts); absent if the model has no known price. */
  costUsd?: number;
  /** Agent loop steps taken. */
  steps?: number;
  /** Tool calls made. */
  toolCalls?: number;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalTrialRecord[];
}

export interface EvalRunsListResponse {
  evalRuns: EvalRunSummary[];
  total: number;
}
