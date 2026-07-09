/**
 * Swappable LLM model registry.
 *
 * The agent (lib/llm/agent.ts) never hardcodes a provider or model. It asks
 * this registry to resolve a `model` key (e.g. "bedrock:balanced") to an AI
 * SDK LanguageModel. Callers (API routes, UI) pick the key per-request, so
 * you can switch between cheap/balanced/expensive, or between Bedrock /
 * Anthropic direct / OpenAI, without touching agent code.
 *
 * Bedrock is the default provider (DEFAULT_MODEL below) — no Anthropic API
 * key required. Bedrock entries ship with well-known, stable Claude-on-
 * Bedrock model IDs so this works with just AWS credentials configured, but
 * they're account/region-specific in general — confirm/override yours with
 * `aws bedrock list-foundation-models --query 'modelSummaries[].modelId'`
 * and BEDROCK_*_MODEL_ID (see ENVIRONMENT_VARIABLES.md). Some accounts
 * require cross-region inference profile IDs instead (prefixed like
 * `us.anthropic...`) — if you get a "model not found"/access error with the
 * defaults below, that's the first thing to check.
 *
 * Anthropic-direct and OpenAI entries are still available (useful to A/B
 * against Bedrock, or if you'd rather not route through AWS) but neither is
 * the default and neither requires the other's credentials to be set.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export type ModelTier = 'cheap' | 'balanced' | 'expensive';
export type ModelProviderName = 'anthropic' | 'bedrock' | 'openai';

export interface ModelRegistryEntry {
  key: string; // what callers pass as `model` in the build request
  label: string; // shown in the UI model picker
  provider: ModelProviderName;
  modelId: string; // provider-specific model id
  tier: ModelTier;
}

let bedrockClient: ReturnType<typeof createAmazonBedrock> | null = null;

/** Lazy so a missing AWS credential chain doesn't break Anthropic/OpenAI-only setups. */
function getBedrockClient() {
  if (!bedrockClient) {
    bedrockClient = createAmazonBedrock({
      // Bedrock requires a region to build its endpoint URL even when using
      // AWS_BEARER_TOKEN_BEDROCK auth (no SigV4 credentials needed) - falls
      // back to us-east-1 if AWS_REGION isn't set, rather than throwing.
      region: process.env.AWS_REGION || 'us-east-1',
      // If these are unset, @ai-sdk/amazon-bedrock falls back to the
      // default AWS credential provider chain (env vars, shared config,
      // instance/task role, SSO, etc) — or to AWS_BEARER_TOKEN_BEDROCK
      // Bearer-token auth if that's set, which takes precedence over both.
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
  }
  return bedrockClient;
}

/**
 * Confirmed live via `aws bedrock list-foundation-models --by-provider
 * anthropic` against a real account (2026-07) — these map to the same
 * current model family as the anthropic:* direct entries below, just with
 * Bedrock's `anthropic.` id prefix. Still account/region-specific in
 * general (see BEDROCK_*_MODEL_ID override below); the previous defaults
 * here (claude-3-5-*) had been retired ("reached end of life") by AWS.
 */
const BEDROCK_DEFAULT_MODEL_IDS: Record<ModelTier, string> = {
  cheap: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  balanced: 'anthropic.claude-sonnet-5',
  expensive: 'anthropic.claude-opus-4-8',
};

function buildDefaultRegistry(): ModelRegistryEntry[] {
  const entries: ModelRegistryEntry[] = [];

  // Bedrock first and unconditional (default provider — no env vars
  // required to appear, though BEDROCK_*_MODEL_ID overrides the model id
  // per tier and AWS credentials are still required to actually call it).
  const bedrockTiers: Array<[ModelTier, string]> = [
    ['cheap', 'BEDROCK_CHEAP_MODEL_ID'],
    ['balanced', 'BEDROCK_BALANCED_MODEL_ID'],
    ['expensive', 'BEDROCK_EXPENSIVE_MODEL_ID'],
  ];
  for (const [tier, envVar] of bedrockTiers) {
    const modelId = process.env[envVar] || BEDROCK_DEFAULT_MODEL_IDS[tier];
    const label = process.env[`${envVar}_LABEL`] || modelId;
    entries.push({ key: `bedrock:${tier}`, label: `${label} (Bedrock — ${tier})`, provider: 'bedrock', modelId, tier });
  }

  entries.push(
    {
      key: 'anthropic:haiku',
      label: 'Claude Haiku 4.5 (Anthropic direct — cheap)',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      tier: 'cheap',
    },
    {
      key: 'anthropic:sonnet',
      label: 'Claude Sonnet 5 (Anthropic direct — balanced)',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      tier: 'balanced',
    },
    {
      key: 'anthropic:opus',
      label: 'Claude Opus 4.8 (Anthropic direct — expensive)',
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      tier: 'expensive',
    }
  );

  const openaiTiers: Array<[ModelTier, string]> = [
    ['cheap', 'OPENAI_CHEAP_MODEL_ID'],
    ['balanced', 'OPENAI_BALANCED_MODEL_ID'],
    ['expensive', 'OPENAI_EXPENSIVE_MODEL_ID'],
  ];
  for (const [tier, envVar] of openaiTiers) {
    const modelId = process.env[envVar];
    if (modelId) {
      entries.push({ key: `openai:${tier}`, label: `${modelId} (OpenAI — ${tier})`, provider: 'openai', modelId, tier });
    }
  }

  // Escape hatch for anything not covered above (more Bedrock foundation
  // models like Llama/Nova/Mistral, additional OpenAI models, etc) without
  // code changes:
  // MODEL_REGISTRY_JSON='[{"key":"bedrock:llama","label":"Llama 3.1 70B (Bedrock)","provider":"bedrock","modelId":"meta.llama3-1-70b-instruct-v1:0","tier":"cheap"}]'
  if (process.env.MODEL_REGISTRY_JSON) {
    try {
      const extra = JSON.parse(process.env.MODEL_REGISTRY_JSON) as ModelRegistryEntry[];
      entries.push(...extra);
    } catch (err) {
      console.error('[model-registry] Failed to parse MODEL_REGISTRY_JSON:', err);
    }
  }

  return entries;
}

let registryCache: ModelRegistryEntry[] | null = null;

export function getModelRegistry(): ModelRegistryEntry[] {
  if (!registryCache) {
    registryCache = buildDefaultRegistry();
  }
  return registryCache;
}

export function getDefaultModelKey(): string {
  return process.env.DEFAULT_MODEL || 'bedrock:balanced';
}

export function getModelEntry(modelKey?: string): ModelRegistryEntry {
  const key = modelKey || getDefaultModelKey();
  const entry = getModelRegistry().find((e) => e.key === key);
  if (!entry) {
    const available = getModelRegistry()
      .map((e) => e.key)
      .join(', ');
    throw new Error(`Unknown model key "${key}". Available: ${available}`);
  }
  return entry;
}

/** Resolve a registry key to an AI SDK LanguageModel, ready to pass to generateText(). */
export function resolveModel(modelKey?: string): LanguageModel {
  const entry = getModelEntry(modelKey);
  switch (entry.provider) {
    case 'anthropic':
      return anthropic(entry.modelId);
    case 'bedrock':
      return getBedrockClient()(entry.modelId);
    case 'openai':
      return openai(entry.modelId);
    default:
      throw new Error(`Unsupported provider "${entry.provider}" for model key "${entry.key}"`);
  }
}
