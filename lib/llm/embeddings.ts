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

import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

let bedrockClient: ReturnType<typeof createAmazonBedrock> | null = null;
function getBedrockClient() {
  if (!bedrockClient) {
    bedrockClient = createAmazonBedrock({
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
  }
  return bedrockClient;
}

function resolveEmbeddingProvider(): 'openai' | 'bedrock' {
  const configured = process.env.EMBEDDING_PROVIDER as 'openai' | 'bedrock' | undefined;
  if (configured) return configured;
  return process.env.OPENAI_API_KEY ? 'openai' : 'bedrock';
}

function resolveEmbeddingModel() {
  const provider = resolveEmbeddingProvider();
  if (provider === 'openai') {
    const modelId = process.env.EMBEDDING_MODEL_ID || 'text-embedding-3-small';
    return openai.textEmbeddingModel(modelId);
  }
  const modelId = process.env.EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
  return getBedrockClient().textEmbeddingModel(modelId);
}

/** Embed a batch of strings, in order. */
export async function embedTexts(values: string[]): Promise<number[][]> {
  if (values.length === 0) return [];
  const { embeddings } = await embedMany({
    model: resolveEmbeddingModel(),
    values,
    // Bedrock's Titan embedding models don't batch server-side; cap
    // concurrency so a ~300-tool catalog doesn't fire 300 simultaneous calls.
    maxParallelCalls: 8,
  });
  return embeddings;
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
