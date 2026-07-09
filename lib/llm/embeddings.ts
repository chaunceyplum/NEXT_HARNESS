/**
 * Swappable embedding provider, used only for tool-shortlisting
 * (lib/llm/tool-retrieval.ts). Independent of the chat-model registry
 * because not every provider you'd pick for chat (e.g. Anthropic) offers an
 * embeddings API.
 *
 * Configure with EMBEDDING_PROVIDER=openai|bedrock and EMBEDDING_MODEL_ID.
 * Defaults to OpenAI's text-embedding-3-small if an OPENAI_API_KEY is set,
 * otherwise falls back to Bedrock Titan embeddings.
 */

import { embedMany, type EmbeddingModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

let bedrockClient: ReturnType<typeof createAmazonBedrock> | null = null;
function getBedrockClient() {
  if (!bedrockClient) {
    bedrockClient = createAmazonBedrock({
      // Falls back to us-east-1 if AWS_REGION isn't set — Bedrock needs a
      // region to build its endpoint URL regardless of auth method, and
      // throws rather than defaulting on its own if none is resolvable.
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
  }
  return bedrockClient;
}

let warnedAboutDefault = false;

function resolveEmbeddingProvider(): 'openai' | 'bedrock' {
  const configured = process.env.EMBEDDING_PROVIDER as 'openai' | 'bedrock' | undefined;
  if (configured) return configured;
  if (process.env.OPENAI_API_KEY) return 'openai';

  // Silent fallback to Bedrock when nothing was configured explicitly —
  // this only works if AWS credentials are available (env vars, shared
  // config, or an instance/task role) *and* Bedrock model access for the
  // Titan embedding model has been granted in this account/region. Warn
  // once so a resulting auth failure isn't a total surprise.
  if (!warnedAboutDefault) {
    warnedAboutDefault = true;
    console.warn(
      '[embeddings] No EMBEDDING_PROVIDER or OPENAI_API_KEY set — defaulting to Bedrock Titan embeddings. ' +
        'Set EMBEDDING_PROVIDER=openai (+ OPENAI_API_KEY) if that is not what you intended, or confirm AWS ' +
        'credentials and Bedrock model access are configured for this environment.'
    );
  }
  return 'bedrock';
}

function resolveEmbeddingModel(): { provider: 'openai' | 'bedrock'; modelId: string; model: EmbeddingModel } {
  const provider = resolveEmbeddingProvider();
  if (provider === 'openai') {
    const modelId = process.env.EMBEDDING_MODEL_ID || 'text-embedding-3-small';
    return { provider, modelId, model: openai.textEmbeddingModel(modelId) };
  }
  const modelId = process.env.EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
  return { provider, modelId, model: getBedrockClient().textEmbeddingModel(modelId) };
}

/** Embed a batch of strings, in order. */
export async function embedTexts(values: string[]): Promise<number[][]> {
  if (values.length === 0) return [];
  const { provider, modelId, model } = resolveEmbeddingModel();
  try {
    const { embeddings } = await embedMany({
      model,
      values,
      // Bedrock's Titan embedding models don't batch server-side; cap
      // concurrency so a ~300-tool catalog doesn't fire 300 simultaneous calls.
      maxParallelCalls: 8,
    });
    return embeddings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const region = provider === 'bedrock' ? ` region=${process.env.AWS_REGION || '(unset)'}` : '';
    throw new Error(`embedding provider=${provider} model=${modelId}${region}: ${message}`, { cause: err });
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
