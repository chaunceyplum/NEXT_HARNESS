/** Shrinks older tool results in the in-flight model context (TASK 2). */

import { type ModelMessage } from 'ai';
import { describeObjects, extractObjects } from '../tools/object-ledger';

// ── TASK 2: prepareStep context compression ───────────────────────────────────

/**
 * Tool messages older than the most recent RESULT_SUMMARY_THRESHOLD have their
 * results compressed to a short summary. Raised from 2 to 4: with only two
 * kept, a list read three steps earlier was already gone by the time the
 * model acted on it. Results are now trimmed to size first (result-trim.ts)
 * and compressed summaries keep their ids, so keeping four is affordable.
 */
export const RESULT_SUMMARY_THRESHOLD = 4;

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
 * tool returned it (after capToolResult's structural trim) — only the model's
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

export interface CompressOptions {
  /** recall_objects is in the tool set: point the model at it instead of a repeat call. */
  recall?: boolean;
  /** Called with the toolCallId of every result compressed (newly or again), so loop detection can forgive a re-fetch of it. */
  onCompressed?: (toolCallId: string, toolName: string, input: unknown) => void;
}

export function compressOldToolMessages(
  messages: readonly ModelMessage[],
  completedSteps: number,
  opts: CompressOptions = {}
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
  // Each compressed result's call input, so onCompressed can report the exact call.
  const inputs = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content) if (part.type === 'tool-call') inputs.set(part.toolCallId, part.input);
  }

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
      opts.onCompressed?.(part.toolCallId, part.toolName, inputs.get(part.toolCallId));
      const value = out.type === 'json' ? out.value : parseMaybe(serialized);
      const objects = describeObjects(extractObjects(value, part.toolName));
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: [
            `[compressed to save context] ${part.toolName} returned ${serialized.length} chars.`,
            objects,
            opts.recall
              ? 'Every id and name it showed is still available: call recall_objects (optionally with a query) rather than repeating this call.'
              : summariseOutputHint(value),
          ]
            .filter(Boolean)
            .join(' '),
        },
      };
    });

    return { ...m, content: newContent };
  });

  return changed ? (rewritten as ModelMessage[]) : undefined;
}

/** A text output that is JSON (e.g. a stringified result) parsed back, so its objects can be read. */
function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

