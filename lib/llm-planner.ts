/**
 * Dynamic Planner
 *
 * This is the piece that makes the build genuinely non-deterministic and
 * ask-specific. It has two layers:
 *
 *   1. SYNTHESIS (preferred, needs ANTHROPIC_API_KEY): an LLM reads the RAW
 *      natural-language request plus a validated catalog of the real,
 *      working MCP tools (lib/tool-catalog.ts) and designs a concrete,
 *      request-specific plan — which tools to call, with what arguments,
 *      chained via refs. Different requests produce genuinely different
 *      plans (different tools, counts, args), not one fixed template with a
 *      reordered set of modules.
 *
 *   2. HEURISTIC FALLBACK (always available): the deterministic capability-
 *      module planner in plan-builder.ts, run against a config that has
 *      first been ENRICHED from the raw description (lib/intent-extractor.ts).
 *      So even with no LLM key, two different requests yield different
 *      configs and therefore different plans — just deterministically.
 *
 * SAFETY / DEGRADATION CONTRACT:
 *   - No API key -> synthesis skipped entirely, straight to the (enriched)
 *     heuristic. No network call.
 *   - Synthesis network failure / timeout (12s) / non-2xx / malformed or
 *     unparseable output -> heuristic fallback, with the reason recorded.
 *   - Synthesized steps are validated against the tool catalog
 *     (validateSynthesizedSteps): unknown/disallowed tools, missing required
 *     params, or malformed/forward refs reject the ENTIRE plan -> heuristic
 *     fallback. A partially-hallucinated plan can never reach the runner.
 *   - planBuildAsync never throws; callers always get a runnable plan.
 */

import { SolutionConfig } from './types';
import { PlannedStep, planUseCase, classifyUseCase, UseCaseProfile, ModulePlanSummary } from './plan-builder';
import { enrichConfigFromDescription } from './intent-extractor';
import { catalogForPrompt, validateSynthesizedSteps, ValidatedStep } from './tool-catalog';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const LLM_TIMEOUT_MS = 12000;

export type PlanningMode = 'llm_synthesized' | 'heuristic';

export interface PlanBuildResult {
  steps: PlannedStep[];
  planningMode: PlanningMode;
  useCase: UseCaseProfile;
  /** The config after intent enrichment (what planning actually ran against). */
  enrichedConfig: SolutionConfig;
  /** Intent flags/notes detected from the raw description (transparency). */
  intentNotes: string[];
  // Heuristic-mode only:
  modules?: ModulePlanSummary[];
  moduleOrder?: string[];
  // Synthesized-mode only:
  reasoning?: string;
  // Set whenever synthesis was attempted but we fell back to heuristic:
  fallbackReason?: string;
}

/**
 * Main entry point used by the build API route. Always resolves with a
 * runnable plan. `description` is the RAW user request (critical — this is
 * what breaks the determinism; the regex-collapsed config alone is not
 * enough signal).
 */
export async function planBuildAsync(
  description: string,
  config: SolutionConfig
): Promise<PlanBuildResult> {
  // Always enrich the config from the raw description first — this benefits
  // both the synthesis prompt and the heuristic fallback.
  const { config: enrichedConfig, intent } = enrichConfigFromDescription(config, description);
  const intentNotes = intent.notes;

  const heuristic = (): PlanBuildResult => {
    const plan = planUseCase(enrichedConfig);
    return {
      steps: plan.steps,
      planningMode: 'heuristic',
      useCase: plan.useCase,
      enrichedConfig,
      intentNotes,
      modules: plan.modules,
      moduleOrder: plan.modules.filter((m) => m.included).map((m) => m.id),
    };
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return heuristic();
  }

  try {
    const result = await synthesizePlan(description, enrichedConfig, apiKey);
    if (result.error || !result.steps) {
      return { ...heuristic(), fallbackReason: result.error || 'Synthesis returned no steps.' };
    }

    const steps: PlannedStep[] = result.steps.map(toPlannedStep);
    return {
      steps,
      planningMode: 'llm_synthesized',
      useCase: classifyUseCase(enrichedConfig),
      enrichedConfig,
      intentNotes,
      reasoning: result.reasoning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...heuristic(), fallbackReason: `Synthesis failed: ${message}` };
  }
}

function toPlannedStep(v: ValidatedStep): PlannedStep {
  return {
    id: v.id,
    label: v.label,
    tool: v.tool,
    category: v.category,
    critical: v.critical,
    args: v.args as Record<string, any>,
    refs: v.refs,
    listRefs: v.listRefs,
  };
}

interface SynthesisResult {
  steps?: ValidatedStep[];
  reasoning?: string;
  error?: string;
}

async function synthesizePlan(
  description: string,
  config: SolutionConfig,
  apiKey: string
): Promise<SynthesisResult> {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const prompt = buildSynthesisPrompt(description, config);

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
        max_tokens: 4096,
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
  if (!text) return { error: 'LLM returned empty content.' };

  const parsed = parseSynthesisResponse(text);
  if (!parsed) return { error: 'Could not parse a JSON plan from the LLM response.' };

  const validation = validateSynthesizedSteps(parsed.steps);
  if (!validation.ok) {
    return { error: `Synthesized plan rejected by catalog validation: ${validation.error}` };
  }

  return { steps: validation.steps, reasoning: parsed.reasoning };
}

function buildSynthesisPrompt(description: string, config: SolutionConfig): string {
  const events = (config.events || []).map((e: any) => (typeof e === 'string' ? e : e?.name));
  const segments = (config.segments || []).map((s: any) => s?.name);

  return `You are an expert Adobe Experience Platform solutions architect. Given a customer's request in plain English, design a CONCRETE build plan as an ordered list of tool calls.

Customer request:
"""
${description}
"""

Parsed context (hints, not limits — trust the request over these):
- domain: ${config.website_domain}
- vertical: ${config.business_vertical}
- events: ${JSON.stringify(events)}
- segments: ${JSON.stringify(segments)}
- destinations: ${JSON.stringify(config.destinations || [])}
- personalization_placements: ${JSON.stringify(config.personalization_placements || [])}
- goals: ${JSON.stringify(config.goals || [])}

You may ONLY use these tools (never invent others — a param marked * is required):
${catalogForPrompt()}

Design rules:
- Build the plan that best fits THIS specific request. DIFFERENT requests must produce DIFFERENT plans — do not emit a fixed template. Include only the tools this request actually needs, and as many segments/rules/offers/journeys as the request implies.
- Chain outputs to inputs with "refs": a ref value is "<earlierStepId>.<path>". Examples: feed a schema step's id into a dataset via {"schema_ref_id": "<schemaStepId>.$id"}; feed a property id via {"property_id": "<propStepId>.id"}; feed a data view via {"data_view_id": "<dvStepId>.data_views.0.id"}; feed a journey via {"journey_id": "<journeyStepId>.journey_id"}.
- Use "listRefs" (a map of arg -> array of "<stepId>.path" refs) for reactor_add_resources_to_library rule_ids / data_element_ids.
- Every ref/listRef MUST point to an EARLIER step's id. Give each step a unique short id (e.g. "schema", "dataset", "seg_vip").
- Supply every REQUIRED param, directly in "args" or via a ref. For object params (CJA "definition", AJO "entry_criteria"/"content") provide a reasonable JSON object.
- Keep it realistic: between 3 and 30 steps. If knowledge grounding helps, start with a search_adobe_knowledge step.

Respond with ONLY JSON, no prose or code fences:
{"steps":[{"id":"...","label":"short human label","tool":"<catalog tool>","args":{...},"refs":{...},"listRefs":{...}}],"reasoning":"1-3 sentences on why this plan fits THIS request"}`;
}

interface ParsedSynthesis {
  steps: unknown;
  reasoning?: string;
}

function parseSynthesisResponse(text: string): ParsedSynthesis | null {
  // Tolerate prose or code fences around the JSON object.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('steps' in parsed)) return null;
  return {
    steps: parsed.steps,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
  };
}
