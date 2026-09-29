/**
 * Model routing (§2.4, §4.5, §6.5): pick a model tier per request instead
 * of sending everything to one model. Simple lookups go to a cheap model and
 * multi-step builds to a strong one, which is one of the biggest cost levers
 * an agent has.
 *
 * Opt-in: a request asks for it with model "auto", and MODEL_ROUTING=true
 * makes "auto" the default when a request names no model. A request that
 * names a model is never re-routed.
 *
 *   1. Rules: keyword classification, free and instant. Decides clear cases.
 *   2. Model: when the rules can't tell, one structured call on the cheap
 *      tier returns {category, confidence, reason, clarifyingQuestion}.
 *   3. Map the category to a tier (ROUTE_TIERS), then to a registry entry on
 *      the default model's provider, skipping unhealthy models. Below
 *      ROUTER_MIN_CONFIDENCE the default model is used instead of a guess.
 *   4. "unclear" never goes to a random specialist: the run returns the
 *      router's clarifying question instead (ROUTER_CLARIFY=false disables).
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { getDefaultModelKey, getModelRegistry, resolveModel, type ModelRegistryEntry, type ModelTier } from './model-registry';
import { defaultModelHealth, type ModelHealthTracker } from './model-health';

export const AUTO_MODEL = 'auto';

export type RouteCategory = 'lookup' | 'change' | 'build' | 'unclear';

export interface RouteDecision {
  category: RouteCategory;
  confidence: number;
  reason: string;
  /** How the category was decided. */
  via: 'rules' | 'model' | 'fallback';
  /** The registry key the run should use. */
  modelKey: string;
  tier?: ModelTier;
  /** For "unclear": what to ask the user instead of running. */
  clarifyingQuestion?: string;
}

export function routingEnabledByDefault(): boolean {
  return process.env.MODEL_ROUTING?.trim().toLowerCase() === 'true';
}

const DEFAULT_TIERS: Record<Exclude<RouteCategory, 'unclear'>, ModelTier> = {
  lookup: 'cheap',
  change: 'balanced',
  build: 'expensive',
};

/** ROUTE_TIERS='{"lookup":"balanced"}' overrides the category → tier map. */
export function routeTiers(): Record<Exclude<RouteCategory, 'unclear'>, ModelTier> {
  try {
    return { ...DEFAULT_TIERS, ...(process.env.ROUTE_TIERS ? JSON.parse(process.env.ROUTE_TIERS) : {}) };
  } catch {
    console.error('[router] Ignoring unparseable ROUTE_TIERS');
    return DEFAULT_TIERS;
  }
}

function minConfidence(): number {
  const n = Number(process.env.ROUTER_MIN_CONFIDENCE);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
}

// ── 1. Rules ──────────────────────────────────────────────────────────────────

const WRITE_WORDS =
  /\b(create|creating|add|update|change|modify|rename|delete|remove|drop|clean ?up|publish|deploy|commit|merge(?! polic)|enable|disable|fix|migrate|set up|configure|build|implement|import|ingest|activate|export)\b/i;
const BUILD_WORDS =
  /\b(end[- ]to[- ]end|from scratch|full (?:setup|implementation|pipeline)|set up (?:a|an|the) (?:new )?\w+ (?:and|with)|and then|multiple|several|all of the|migrate|implement)\b/i;
const QUESTION_WORDS =
  /^\s*(what|which|who|where|when|why|how|list|show|find|get|count|is|are|does|do|can|explain|describe|tell me|give me)\b|\?\s*$/i;

/** A category the rules are sure of, or undefined to ask the model. */
export function classifyByRules(request: string): { category: RouteCategory; confidence: number; reason: string } | undefined {
  // "fix it", "delete that": a verb with only a pronoun for an object. The model can ask what "it" is.
  const words = request.trim().split(/\s+/);
  if (words.length <= 4 && /\b(it|that|this|them|those|these)\b/i.test(request)) return undefined;
  const writes = WRITE_WORDS.test(request);
  const question = QUESTION_WORDS.test(request);
  if (question && !writes) return { category: 'lookup', confidence: 0.85, reason: 'a question with no change verbs' };
  if (writes && BUILD_WORDS.test(request)) return { category: 'build', confidence: 0.75, reason: 'multi-part change wording' };
  if (writes && !question) return { category: 'change', confidence: 0.75, reason: 'change verbs, not a question' };
  return undefined;
}

// ── 2. Model ──────────────────────────────────────────────────────────────────

const routeSchema = z.object({
  category: z
    .enum(['lookup', 'change', 'build', 'unclear'])
    .describe(
      'lookup: answer a question or read data, no changes. change: one focused change (create/update/delete one or a few things). build: a multi-step build touching several resources. unclear: cannot tell what is being asked.'
    ),
  confidence: z.number().min(0).max(1).describe('How sure you are of the category, 0-1.'),
  reason: z.string().max(200).describe('One short sentence.'),
  clarifyingQuestion: z.string().max(300).optional().describe('Only for "unclear": the one question that would resolve it.'),
});

async function classifyByModel(request: string, routerKey: string): Promise<{ category: RouteCategory; confidence: number; reason: string; clarifyingQuestion?: string }> {
  const { object } = await generateObject({
    model: resolveModel(routerKey),
    schema: routeSchema,
    system:
      'You route requests for a MarTech engineering agent (Adobe Experience Platform, CJA, Launch/Reactor, GitHub) to the right model size. Classify the request; do not answer it.',
    prompt: request,
  });
  return object;
}

// ── 3. Tier → model ───────────────────────────────────────────────────────────

/** The registry entry for `tier` on the default model's provider (healthy first), or undefined. */
export function modelForTier(
  tier: ModelTier,
  registry: ModelRegistryEntry[] = getModelRegistry(),
  health: ModelHealthTracker = defaultModelHealth
): string | undefined {
  const defaultEntry = registry.find((e) => e.key === getDefaultModelKey());
  const candidates = registry.filter((e) => e.tier === tier && (!defaultEntry || e.provider === defaultEntry.provider));
  return (candidates.find((e) => !health.isUnhealthy(e.key)) ?? candidates[0])?.key;
}

export async function routeRequest(
  request: string,
  opts: { registry?: ModelRegistryEntry[]; health?: ModelHealthTracker; classify?: typeof classifyByModel } = {}
): Promise<RouteDecision> {
  const registry = opts.registry ?? getModelRegistry();
  const fallbackKey = getDefaultModelKey();
  const fallback = (reason: string): RouteDecision => ({ category: 'change', confidence: 0, reason, via: 'fallback', modelKey: fallbackKey });

  let decided: { category: RouteCategory; confidence: number; reason: string; clarifyingQuestion?: string };
  let via: RouteDecision['via'];
  const byRules = classifyByRules(request);
  if (byRules) {
    decided = byRules;
    via = 'rules';
  } else {
    const routerKey = modelForTier('cheap', registry, opts.health) ?? fallbackKey;
    try {
      decided = await (opts.classify ?? classifyByModel)(request, routerKey);
      via = 'model';
    } catch (err) {
      return fallback(`router call failed (${err instanceof Error ? err.message : String(err)}); using the default model`);
    }
  }

  if (decided.category === 'unclear') {
    if (process.env.ROUTER_CLARIFY?.trim().toLowerCase() !== 'false' && decided.clarifyingQuestion) {
      return { ...decided, via, modelKey: fallbackKey };
    }
    return fallback(`unclear request (${decided.reason}); using the default model`);
  }
  if (decided.confidence < minConfidence()) {
    return { ...fallback(`low confidence ${decided.confidence.toFixed(2)} for "${decided.category}" (${decided.reason}); using the default model`), category: decided.category, confidence: decided.confidence, via };
  }
  const tier = routeTiers()[decided.category];
  const modelKey = modelForTier(tier, registry, opts.health);
  if (!modelKey) return fallback(`no ${tier} model on the default provider; using the default model`);
  return { category: decided.category, confidence: decided.confidence, reason: decided.reason, via, tier, modelKey };
}
