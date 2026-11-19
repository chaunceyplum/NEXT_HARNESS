/** Shrinks older tool results in the in-flight model context (TASK 2). */

import { type ModelMessage } from 'ai';

// ── TASK 2: prepareStep context compression ───────────────────────────────────

/**
 * Steps older than this threshold have their tool results compressed to a
 * one-line summary. The current step and the one before it are kept at full
 * fidelity so the model can reason about what it just did.
 */
export const RESULT_SUMMARY_THRESHOLD = 2;

/**
 * Old results are compressed this many tool messages at a time. Compressing
 * changes the history from that message on, which restarts the prompt cache
 * from there; moving the boundary one message per step would restart it every
 * step. In batches, the history stays byte-identical (and cached) between moves.
 */
const COMPRESS_BATCH = 4;

/**
 * Compress tool results in the conversation history for steps older than
 * RESULT_SUMMARY_THRESHOLD. Large list/read payloads otherwise accumulate at
 * full size in the context that's resent on every turn (the same mechanism
 * behind the documented 400K-token run). The trace keeps each result as the
 * tool returned it (after capToolResult's 8K cap) — only the model's
 * in-flight context is shrunk further.
 *
 * Returns a new messages array if anything was compressed, or undefined to
 * leave the messages untouched (so we only override when it actually helps).
 *
 * Strategy: tool messages appear in call order. We keep the tool results from
 * at least the most recent RESULT_SUMMARY_THRESHOLD tool messages at full
 * fidelity and summarise the text/JSON output of older ones, COMPRESS_BATCH
 * at a time. Only outputs above a size
 * floor are touched, so small confirmation objects are left alone.
 */
const COMPRESS_FLOOR_CHARS = 500;

export function compressOldToolMessages(
  messages: readonly ModelMessage[],
  completedSteps: number
): ModelMessage[] | undefined {
  if (completedSteps < RESULT_SUMMARY_THRESHOLD) return undefined;

  // Index of tool messages so we can keep the last N intact.
  const toolMsgIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolMsgIndexes.push(i);
  });
  const compressible = Math.floor((toolMsgIndexes.length - RESULT_SUMMARY_THRESHOLD) / COMPRESS_BATCH) * COMPRESS_BATCH;
  if (compressible <= 0) return undefined;

  const keepFrom = toolMsgIndexes[compressible];
  let changed = false;

  const rewritten = messages.map((m, i) => {
    if (m.role !== 'tool' || i >= keepFrom) return m;
    if (!Array.isArray(m.content)) return m;

    const newContent = m.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const out = part.output as { type?: string; value?: unknown };
      if (!out || (out.type !== 'text' && out.type !== 'json')) return part;

      const serialized = out.type === 'text' ? String(out.value) : JSON.stringify(out.value);
      if (serialized.length <= COMPRESS_FLOOR_CHARS) return part;

      changed = true;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: `[compressed to save context] ${part.toolName} returned ${serialized.length} chars. ${summariseOutputHint(out.type === 'json' ? out.value : serialized)}`,
        },
      };
    });

    return { ...m, content: newContent };
  });

  return changed ? (rewritten as ModelMessage[]) : undefined;
}

/** One-line hint about a compressed output so the model still has a signal. */
function summariseOutputHint(output: unknown): string {
  if (Array.isArray(output)) {
    return `Result was a list of ${output.length} item(s) — call the tool again with narrower arguments to re-fetch specific entries.`;
  }
  if (output && typeof output === 'object') {
    const keys = Object.keys(output as object);
    return `Result was an object with keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? `, …+${keys.length - 8}` : ''}. Re-fetch if you need the full content.`;
  }
  return 'Re-fetch with narrower arguments if you need the full content.';
}

