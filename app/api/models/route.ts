/**
 * GET /api/models
 *
 * Lists the models currently available for the UI's model picker. Backed by
 * lib/llm/model-registry.ts — add Bedrock/OpenAI entries via env vars
 * (see ENVIRONMENT_VARIABLES.md) and they show up here automatically.
 */

import { getDefaultModelKey, getModelRegistry } from '@/lib/llm/model-registry';
import { ModelOption } from '@/lib/types';

export async function GET(): Promise<Response> {
  const options: ModelOption[] = getModelRegistry().map((entry) => ({
    key: entry.key,
    label: entry.label,
    tier: entry.tier,
  }));

  return Response.json({ models: options, defaultModel: getDefaultModelKey() }, { status: 200 });
}
