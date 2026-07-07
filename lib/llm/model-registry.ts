/**
 * Swappable LLM model registry.
 *
 * The agent (lib/llm/agent.ts) never hardcodes a provider or model. It asks
 * this registry to resolve a `model` key (e.g. "anthropic:sonnet") to an AI
 * SDK LanguageModel. Callers (API routes, UI) pick the key per-request, so
 * you can switch between cheap/balanced/expensive, or between Anthropic
 * direct / Bedrock / OpenAI, without touching agent code.
 *
 * Anthropic entries use confirmed current model IDs. Bedrock and OpenAI
 * entries are intentionally environment-driven:
 *  - Bedrock model IDs are account/region-specific. Confirm yours with
 *    `aws bedrock list-foundation-models --query 'modelSummaries[].modelId'`
 *    and set BEDROCK_*_MODEL_ID below.
 *  - OpenAI model names change on their own release cadence; set
 *    OPENAI_*_MODEL_ID to whatever you want to use.
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
      region: process.env.AWS_REGION,
      // If these are unset, @ai-sdk/amazon-bedrock falls back to the
      // default AWS credential provider chain (env vars, shared config,
      // instance/task role, SSO, etc).
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
  }
  return bedrockClient;
}

function buildDefaultRegistry(): ModelRegistryEntry[] {
  const entries: ModelRegistryEntry[] = [
    {
      key: 'anthropic:haiku',
      label: 'Claude Haiku 4.5 (Anthropic — cheap)',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      tier: 'cheap',
    },
    {
      key: 'anthropic:sonnet',
      label: 'Claude Sonnet 5 (Anthropic — balanced)',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      tier: 'balanced',
    },
    {
      key: 'anthropic:opus',
      label: 'Claude Opus 4.8 (Anthropic — expensive)',
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      tier: 'expensive',
    },
  ];

  const bedrockTiers: Array<[ModelTier, string]> = [
    ['cheap', 'BEDROCK_CHEAP_MODEL_ID'],
    ['balanced', 'BEDROCK_BALANCED_MODEL_ID'],
    ['expensive', 'BEDROCK_EXPENSIVE_MODEL_ID'],
  ];
  for (const [tier, envVar] of bedrockTiers) {
    const modelId = process.env[envVar];
    if (modelId) {
      const label = process.env[`${envVar}_LABEL`] || modelId;
      entries.push({ key: `bedrock:${tier}`, label: `${label} (Bedrock — ${tier})`, provider: 'bedrock', modelId, tier });
    }
  }

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
  return process.env.DEFAULT_MODEL || 'anthropic:sonnet';
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
