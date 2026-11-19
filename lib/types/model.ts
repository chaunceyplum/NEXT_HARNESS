/** Model choice: the router decision and the model picker options (lib/llm/models). */

/** Mirrors lib/llm/models/model-router.ts RouteDecision (kept here so client code needn't import server modules). */
export interface RouteRecord {
  category: 'lookup' | 'change' | 'build' | 'unclear';
  confidence: number;
  reason: string;
  via: 'rules' | 'model' | 'fallback';
  modelKey: string;
  tier?: 'cheap' | 'balanced' | 'expensive';
  clarifyingQuestion?: string;
}

export interface ModelOption {
  key: string;
  label: string;
  tier: 'cheap' | 'balanced' | 'expensive';
}
