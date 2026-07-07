/**
 * LLM Planner (optional refinement layer)
 *
 * The deterministic module system in plan-builder.ts (`planUseCase`) already
 * makes the build plan use-case aware: it decides which capability modules
 * (RAG/AEP/Launch/CJA/AJO activation/AJO offers) apply and in what order,
 * based on heuristics read off the planner's SolutionConfig.
 *
 * This module adds an *optional* LLM pass on top: given the same config and
 * the same heuristic result, ask an LLM whether it agrees with which
 * modules should run and in what order, and let it override both — because
 * heuristics are necessarily coarse (a handful of if/else signals) and a
 * genuinely novel use case description may call for a module combination
 * the heuristics don't anticipate.
 *
 * SAFETY / DEGRADATION CONTRACT — this is the important part:
 *   - If ANTHROPIC_API_KEY is not set, the LLM is never called. No network
 *     request, no delay, straight to the heuristic result.
 *   - If the API call fails, times out (8s budget), or returns a
 *     non-2xx / malformed response, the heuristic result is used.
 *   - If the LLM's response *parses* but is semantically invalid (not a
 *     permutation of exactly the applicable module ids, includes an
 *     unknown module, is missing a module, etc.), the heuristic result is
 *     used. The LLM can only ever reorder or drop-with-justification
 *     modules that isApplicable() already allowed through — it cannot
 *     invent calls to tools that don't exist, and it never sees or
 *     produces raw PlannedStep/tool-call content itself.
 *   - Any exception anywhere in this module is caught; callers always get
 *     a valid UseCasePlan back, never a throw.
 *
 * In other words: this is a pure planning *hint* layered on top of a
 * working deterministic planner, never a replacement for one.
 */

import { SolutionConfig } from './types';
import { MODULES, planUseCase, classifyUseCase, ModuleId, UseCasePlan, ModulePlanSummary } from './plan-builder';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const LLM_TIMEOUT_MS = 8000;

export type PlanningMode = 'llm' | 'heuristic';

export interface PlanUseCaseResult extends UseCasePlan {
  planningMode: PlanningMode;
  /** Present only when planningMode === 'llm': the model's stated rationale. */
  llmReasoning?: string;
  /** Present only when the LLM path was attempted but fell back — why. */
  llmFallbackReason?: string;
}

/**
 * Async entry point used by the build API route. Always resolves — never
 * rejects — and always returns a usable plan.
 */
export async function planUseCaseAsync(config: SolutionConfig): Promise<PlanUseCaseResult> {
  const heuristicPlan = planUseCase(config);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...heuristicPlan, planningMode: 'heuristic' };
  }

  try {
    const refinement = await requestLlmRefinement(config, heuristicPlan, apiKey);
    if (!refinement) {
      return { ...heuristicPlan, planningMode: 'heuristic', llmFallbackReason: 'LLM returned no usable refinement.' };
    }

    const applicableIds = heuristicPlan.modules.filter((m) => m.included).map((m) => m.id);
    const validationError = validateModuleOrder(refinement.moduleOrder, applicableIds);
    if (validationError) {
      return { ...heuristicPlan, planningMode: 'heuristic', llmFallbackReason: validationError };
    }

    const rebuilt = rebuildFromOrder(config, refinement.moduleOrder, heuristicPlan.modules);
    return {
      ...rebuilt,
      useCase: heuristicPlan.useCase,
      planningMode: 'llm',
      llmReasoning: refinement.reasoning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...heuristicPlan, planningMode: 'heuristic', llmFallbackReason: `LLM refinement failed: ${message}` };
  }
}

interface LlmRefinement {
  moduleOrder: string[];
  reasoning: string;
}

async function requestLlmRefinement(
  config: SolutionConfig,
  heuristicPlan: UseCasePlan,
  apiKey: string
): Promise<LlmRefinement | null> {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const applicable = heuristicPlan.modules.filter((m) => m.included);

  const prompt = buildPrompt(config, heuristicPlan, applicable);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Anthropic API HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const data = await response.json();
  const text: string | undefined = data?.content?.[0]?.text;
  if (!text) return null;

  return parseLlmResponse(text);
}

function buildPrompt(config: SolutionConfig, heuristicPlan: UseCasePlan, applicable: ModulePlanSummary[]): string {
  const moduleDescriptions = applicable
    .map((m) => `  - "${m.id}": ${m.label} (heuristic included it because: ${m.reason})`)
    .join('\n');

  return `You are helping order build steps for a martech (Adobe Experience Platform) implementation.

A deterministic heuristic already decided which capability modules apply to this use case and produced a default order. Your job is ONLY to review and, if you disagree, propose a different ORDER for the SAME set of modules — you cannot add or remove modules.

Use case description context:
  - website_domain: ${config.website_domain}
  - business_vertical: ${config.business_vertical}
  - events: ${JSON.stringify((config.events || []).map((e: any) => (typeof e === 'string' ? e : e?.name)))}
  - segments: ${JSON.stringify((config.segments || []).map((s: any) => s?.name))}
  - destinations: ${JSON.stringify(config.destinations || [])}
  - personalization_placements: ${JSON.stringify(config.personalization_placements || [])}
  - goals: ${JSON.stringify(config.goals || [])}

Applicable modules (you must include EVERY one of these ids exactly once, in whatever order you think is best):
${moduleDescriptions}

Heuristic's default order: ${JSON.stringify(heuristicPlan.modules.filter((m) => m.included).map((m) => m.id))}

Respond with ONLY a JSON object, no other text, in this exact shape:
{"module_order": ["module_id", "module_id", ...], "reasoning": "one or two sentences explaining the order"}

The "module_order" array MUST contain exactly the same module ids listed above (every one, no duplicates, no new ids) — only their order may change.`;
}

function parseLlmResponse(text: string): LlmRefinement | null {
  // Be tolerant of the model wrapping JSON in prose or a code fence.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.module_order)) return null;
  if (!parsed.module_order.every((id: any) => typeof id === 'string')) return null;

  return {
    moduleOrder: parsed.module_order,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided.',
  };
}

/**
 * Validate that the LLM's proposed order is exactly a permutation of the
 * applicable module ids — same set, same count, no additions or omissions.
 * Returns an error string if invalid, or null if valid.
 */
function validateModuleOrder(proposedOrder: string[], applicableIds: ModuleId[]): string | null {
  const knownIds = new Set(MODULES.map((m) => m.id));
  const unknown = proposedOrder.filter((id) => !knownIds.has(id as ModuleId));
  if (unknown.length > 0) {
    return `LLM proposed unknown module id(s): ${unknown.join(', ')}.`;
  }

  const proposedSet = new Set(proposedOrder);
  if (proposedSet.size !== proposedOrder.length) {
    return 'LLM proposed duplicate module ids in its order.';
  }

  const applicableSet = new Set(applicableIds);
  const missing = applicableIds.filter((id) => !proposedSet.has(id));
  const extra = proposedOrder.filter((id) => !applicableSet.has(id as ModuleId));

  if (missing.length > 0) {
    return `LLM's proposed order is missing required module(s): ${missing.join(', ')}.`;
  }
  if (extra.length > 0) {
    return `LLM's proposed order includes module(s) the heuristic marked not applicable: ${extra.join(', ')}.`;
  }

  return null;
}

/**
 * Rebuild the full UseCasePlan's step list using the LLM-approved module
 * order, reusing each module's own `build()` — the LLM never generates
 * PlannedStep/tool-call content itself, only the ordering of modules whose
 * step-generation logic is exactly the same deterministic code as the
 * heuristic path.
 */
function rebuildFromOrder(
  config: SolutionConfig,
  order: string[],
  moduleSummaries: ModulePlanSummary[]
): UseCasePlan {
  const useCase = classifyUseCase(config);
  const ctx = { aepSegmentStepIds: [] as string[], aepSchemaStepId: undefined as string | undefined };
  const byId = new Map(MODULES.map((m) => [m.id as string, m]));
  const summaryById = new Map(moduleSummaries.map((s) => [s.id, s]));

  const steps = [];
  const orderedSummaries: ModulePlanSummary[] = [];

  // Rebuild summaries in the LLM's chosen order (not the heuristic's
  // original order) — this is what module_order in the API response and
  // the UI's step-order display reflect, so it must match the order steps
  // actually ran in.
  for (const id of order) {
    const mod = byId.get(id as ModuleId);
    const originalSummary = summaryById.get(id as ModuleId);
    if (!mod || !originalSummary) continue; // unreachable given prior validation, but stay defensive
    const modSteps = mod.build(config, ctx);
    steps.push(...modSteps);
    orderedSummaries.push({ ...originalSummary, stepCount: modSteps.length });
  }

  // Modules the heuristic marked not-applicable were never in `order`
  // (validated) — append them unchanged for the "skipped modules" list.
  for (const s of moduleSummaries) {
    if (!s.included) orderedSummaries.push({ ...s });
  }

  return { steps, useCase, modules: orderedSummaries };
}
