/**
 * The run's object ledger: every Adobe object (and other identified resource)
 * a tool result has shown the model during one run, by id.
 *
 * Older tool results leave the model's context as a run goes on, through
 * compressOldToolMessages (context-compression.ts) on most models and through
 * server-side context editing on history-bound ones. Before this ledger, the
 * ids those results carried went with them: the model either re-listed
 * (burning steps, and tripping loop detection on identical calls) or guessed
 * an id from memory. The ledger keeps them outside the context:
 *
 *   - withObjectLedger() records the identity of every object in every tool
 *     result as it comes back (after trimming, which keeps identities);
 *   - the recall_objects tool lets the model look them up again at any time,
 *     without repeating the original call;
 *   - compression placeholders name the ids the compressed result held;
 *   - a worker hands the objects it saw to the steps that depend on it.
 *
 * Pure apart from the in-memory map; one ledger per run (per model attempt
 * is not needed: a fallback re-runs from scratch but ids it saw stay valid).
 */

import { jsonSchema, tool, type Tool, type ToolSet } from 'ai';
import { effectiveToolCall } from './tool-discovery';

export interface LedgerEntry {
  id: string;
  /** Human-readable name or title, when the result carried one. */
  label?: string;
  /** Object type: the result's own `type` / `meta:resourceType`, or the noun from the tool name. */
  kind?: string;
  /** The tool whose result first showed it (the latest one, if seen again). */
  tool: string;
  sandbox?: string;
}

/** Ids at this many objects per result are enough; a result past it is a bulk export, not a listing. */
const MAX_PER_RESULT = 1_000;
/** Per-run ceiling, so a pathological run can't grow the ledger without bound. */
const MAX_ENTRIES = 5_000;
const MAX_LABEL_CHARS = 120;
const MAX_DEPTH = 8;

/** Tools whose results are not data about the platform. */
const NOT_RECORDED = new Set([
  'recall_objects',
  'find_tools',
  'policy_info',
  'update_plan',
  'revise_plan',
  'remember_fact',
  'report_result',
  'search_knowledge',
]);

const ID_KEYS = ['$id', 'id', '@id', 'uuid'] as const;
const LABEL_KEYS = ['title', 'name', 'displayName', 'display_name', 'label'] as const;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** "adobe_list_schemas" → "schemas", "reactor_get_rule" → "rule", "cja_list_data_views" → "data_views". */
export function kindFromToolName(toolName: string): string | undefined {
  const parts = toolName.split('_');
  const verbAt = parts.findIndex((p) => /^(?:list|get|create|update|search|find|read|describe|preview)$/.test(p));
  const noun = verbAt >= 0 ? parts.slice(verbAt + 1).join('_') : '';
  return noun || undefined;
}

/** The identity of every object in a result: id plus, when present, label, kind and sandbox. */
export function extractObjects(result: unknown, toolName: string): Array<Omit<LedgerEntry, 'tool'>> {
  const out: Array<Omit<LedgerEntry, 'tool'>> = [];
  const fallbackKind = kindFromToolName(toolName);

  const visit = (v: unknown, depth: number): void => {
    if (out.length >= MAX_PER_RESULT || depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;

    const idKey = ID_KEYS.find((k) => str(v[k]) !== undefined);
    if (idKey) {
      const attrs = isPlainObject(v.attributes) ? v.attributes : undefined;
      const labelKey = LABEL_KEYS.find((k) => str(v[k]) !== undefined);
      const attrLabelKey = attrs ? LABEL_KEYS.find((k) => str(attrs[k]) !== undefined) : undefined;
      const rawLabel = labelKey ? str(v[labelKey]) : attrLabelKey && attrs ? str(attrs[attrLabelKey]) : undefined;
      const label = rawLabel?.replace(/…\(\+\d+ chars\)$/, '').slice(0, MAX_LABEL_CHARS);
      // JSON:API `type` ("rules", "properties") and AEP's meta:resourceType name the kind better than the tool does.
      const kind = str(v['meta:resourceType']) ?? (typeof v.type === 'string' && v.type.length <= 40 && !/^(?:object|string|array|number|integer|boolean)$/.test(v.type) ? v.type : undefined) ?? fallbackKind;
      const sandbox = str(v.sandboxName) ?? str(isPlainObject(v.sandbox) ? v.sandbox.name : v.sandbox);
      out.push({ id: str(v[idKey])!, ...(label ? { label } : {}), ...(kind ? { kind } : {}), ...(sandbox ? { sandbox } : {}) });
    }
    for (const [k, child] of Object.entries(v)) {
      if (k === '_trimmed' || k === 'links' || k === '_links') continue;
      if (typeof child === 'object' && child !== null) visit(child, depth + 1);
    }
  };

  visit(result, 0);
  return out;
}

export class ObjectLedger {
  private readonly byId = new Map<string, LedgerEntry>();

  get size(): number {
    return this.byId.size;
  }

  /** Record the objects in one tool result. Returns how many were new to the ledger. */
  record(toolName: string, result: unknown): number {
    if (NOT_RECORDED.has(toolName)) return 0;
    let added = 0;
    for (const obj of extractObjects(result, toolName)) {
      const existing = this.byId.get(obj.id);
      if (!existing && this.byId.size >= MAX_ENTRIES) break;
      if (!existing) added++;
      // A later sighting fills in what an earlier one lacked (a bare relationship id, then the full item).
      this.byId.set(obj.id, {
        id: obj.id,
        tool: toolName,
        ...(obj.label ?? existing?.label ? { label: obj.label ?? existing?.label } : {}),
        ...(obj.kind ?? existing?.kind ? { kind: obj.kind ?? existing?.kind } : {}),
        ...(obj.sandbox ?? existing?.sandbox ? { sandbox: obj.sandbox ?? existing?.sandbox } : {}),
      });
    }
    return added;
  }

  /** Entries in the order first seen, optionally filtered by a case-insensitive substring of id / label / kind / tool. */
  entries(query?: string): LedgerEntry[] {
    const all = [...this.byId.values()];
    const q = query?.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((e) => {
      const hay = `${e.id} ${e.label ?? ''} ${e.kind ?? ''} ${e.tool}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
}

/** One line for a compression placeholder: the ids a compressed result held, capped. */
export function describeObjects(objects: ReadonlyArray<Omit<LedgerEntry, 'tool'>>, maxChars = 600): string {
  if (objects.length === 0) return '';
  const parts: string[] = [];
  let used = 0;
  for (const o of objects) {
    const part = o.label ? `${o.id} ("${o.label}")` : o.id;
    if (used + part.length > maxChars) break;
    parts.push(part);
    used += part.length + 2;
  }
  const rest = objects.length - parts.length;
  return `It held ${objects.length} object(s): ${parts.join(', ')}${rest > 0 ? `, +${rest} more` : ''}.`;
}

/**
 * Wrap every tool so its result is recorded in `ledger`. call_tool is
 * recorded under the tool it proxied. The result itself is returned unchanged.
 */
export function withObjectLedger(tools: ToolSet, ledger: ObjectLedger): ToolSet {
  const out: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const original = def.execute;
    if (!original || NOT_RECORDED.has(name)) {
      out[name] = def;
      continue;
    }
    out[name] = {
      ...def,
      execute: async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
        const result = await original(input as never, options);
        ledger.record(effectiveToolCall(name, input).toolName, result);
        return result;
      },
    } as typeof def;
  }
  return out;
}

/** OBJECT_LEDGER=false turns the ledger and recall_objects off (on by default). */
export function objectLedgerEnabled(): boolean {
  return process.env.OBJECT_LEDGER?.trim().toLowerCase() !== 'false';
}

const DEFAULT_RECALL_LIMIT = 100;
const MAX_RECALL_LIMIT = 300;

/** The recall_objects tool: read the ledger back without repeating the original call. */
export function recallObjectsTool(ledger: ObjectLedger): Tool {
  return tool({
    description:
      'List the objects (ids, names, kinds) that tool results have shown earlier in this run — schemas, field groups, datasets, ' +
      'segments, Launch properties, rules, data elements and so on. Use it instead of re-calling a list tool when an earlier ' +
      'result was compressed or cleared from your context, or when you need an id you saw before. It cannot fetch anything new.',
    inputSchema: jsonSchema<{ query?: string; limit?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words that must all appear in the id, name, kind or source tool, e.g. "loyalty schema" or "rules".' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RECALL_LIMIT, description: `Most entries to return (default ${DEFAULT_RECALL_LIMIT}).` },
      },
      additionalProperties: false,
    }),
    execute: async ({ query, limit }) => {
      const matches = ledger.entries(query);
      const n = Math.min(MAX_RECALL_LIMIT, Math.max(1, limit ?? DEFAULT_RECALL_LIMIT));
      const shown = matches.slice(-n);
      return {
        total: matches.length,
        shown: shown.length,
        objects: shown,
        note:
          matches.length === 0
            ? ledger.size === 0
              ? 'No tool result has shown any object yet in this run.'
              : 'Nothing matched. Try fewer or different words, or omit query to list everything.'
            : matches.length > shown.length
              ? `Showing the ${shown.length} most recent of ${matches.length}. Narrow with query.`
              : 'These are ids exactly as the tools returned them.',
      };
    },
  });
}
