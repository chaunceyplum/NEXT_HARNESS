/** Answer and retrieval checks as stored on a run (lib/llm/quality). */

export interface RagJudgment {
  /** 0 (irrelevant) to 5 (squarely on-topic). */
  relevance: number;
  /** Whether the results contain enough to actually answer the query, independent of relevance. */
  sufficient: boolean;
  verdict: 'good' | 'weak' | 'poor';
  rationale: string;
  /** Model registry key the judgment was scored with, so a judgment can be discounted if that model is known-unreliable. */
  judgeModel: string;
}

/**
 * One knowledge-search quality judgment collected during a run by the
 * fire-and-forget RAG judge (lib/llm/quality/rag-judge.ts), persisted with the run
 * record for monitoring. Mirrors RagJudgmentEntry in the tool layer.
 * RagJudgment lives here (not in rag-judge.ts) so these types import no
 * implementation; rag-judge.ts imports it from here.
 */
export interface RagJudgmentRecord {
  toolName: string;
  query: string;
  judgment: RagJudgment;
}

/** Grounding check on the final answer (lib/llm/quality/answer-critic.ts). */
export interface CritiqueRecord {
  passed: boolean;
  grounded: boolean;
  answersRequest: boolean;
  unsupportedClaims: string[];
  issues: string[];
  revised: boolean;
  originalAnswer?: string;
  model: string;
  /** The critic was the same model that wrote the answer. */
  selfCheck?: boolean;
}
