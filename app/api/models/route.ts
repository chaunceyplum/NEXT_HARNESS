/**
 * GET /api/models
 *
 * Lists the models currently available for the UI's model picker. Backed by
 * lib/llm/model-registry.ts — add Bedrock/OpenAI entries via env vars
 * (see ENVIRONMENT_VARIABLES.md) and they show up here automatically.
 */

import { getDefaultModelKey, getModelRegistry } from '@/lib/llm/model-registry';
import { AUTO_MODEL, routingEnabledByDefault } from '@/lib/llm/model-router';
import { ModelOption } from '@/lib/types';

export async function GET(): Promise<Response> {
  const options: ModelOption[] = getModelRegistry().map((entry) => ({
    key: entry.key,
    label: entry.label,
    tier: entry.tier,
  }));

  // "auto" routes each request to a tier (lib/llm/model-router.ts).
  const auto: ModelOption = { key: AUTO_MODEL, label: 'Auto (route by request: cheap / balanced / strong)', tier: 'balanced' };
  return Response.json(
    { models: [auto, ...options], defaultModel: routingEnabledByDefault() ? AUTO_MODEL : getDefaultModelKey() },
    { status: 200 }
  );
}
