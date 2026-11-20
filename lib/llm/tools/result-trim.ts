/**
 * Structure-aware trimming for oversized tool results (pure, no I/O).
 *
 * The old cap stringified a result and sliced it at 8,000 chars, so a large
 * AEP list (schemas, field groups, segments, Launch rules) reached the model
 * as a broken JSON prefix holding the first few items. The model read that
 * prefix as the whole list and then guessed, or claimed, that the rest did
 * not exist.
 *
 * This trims a result in escalating levels and stops at the first one that
 * fits, so the output is always valid JSON and every list keeps every item's
 * identity (id, name, title, status...) for as long as possible:
 *
 *   1. long-text   long strings shortened; structure untouched
 *   2. shallow     list items keep their scalar fields; nested objects inside
 *                  an item shrink to their identity fields
 *   3. identity    list items keep only their identity fields
 *   4. list-cut    (last resort) long lists keep their first items, and the
 *                  result states how many were left out
 *
 * Levels 1-3 must fit `maxChars`. An identity-only index of a large list may
 * use up to `indexMaxChars`, because a complete id list is worth more to the
 * model than a few complete items. Every trimmed result carries a `_trimmed`
 * note saying what was dropped and how to get the detail back.
 */

export type TrimLevel = 'long-text' | 'shallow' | 'identity' | 'list-cut';

export interface TrimNote {
  /** Size of the result as the tool returned it, in JSON chars. */
  originalChars: number;
  /** The most aggressive level that was needed. */
  level: TrimLevel;
  /** Field names removed from list items (up to 20). */
  droppedFields?: string[];
  /** Items left out of lists at the list-cut level. */
  omittedItems?: number;
  note: string;
}

export interface TrimOptions {
  /** Size a trimmed result should fit (levels 1-3). */
  maxChars: number;
  /** Larger size allowed for an identity-only index of a big list (level 3-4). */
  indexMaxChars: number;
}

/** Keys that identify an object: kept at every level. */
const IDENTITY_KEY =
  /^(?:id|\$id|@id|_id|uuid|name|title|key|displayname|display_name|label|type|status|state|kind|version|enabled|meta:class|meta:status|meta:altid|meta:resourcetype|meta:intendedtosuppressprofile|sandboxname|rsid)$/i;
/** Foreign keys and other *_id / *Id fields: also identity. */
const ID_SUFFIX = /(?:_id|Id|ID|_ids|Ids)$/;

function isIdentityKey(key: string): boolean {
  return IDENTITY_KEY.test(key) || ID_SUFFIX.test(key);
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Level {
  name: TrimLevel;
  stringMax: number;
  /** How a list item (or keyed-collection value) is reduced. */
  item: 'full' | 'shallow' | 'identity';
  /** Description strings are shortened harder than other text at identity level. */
  descriptionMax: number;
}

const LEVELS: Level[] = [
  { name: 'long-text', stringMax: 400, item: 'full', descriptionMax: 400 },
  { name: 'shallow', stringMax: 160, item: 'shallow', descriptionMax: 160 },
  { name: 'identity', stringMax: 120, item: 'identity', descriptionMax: 60 },
];

const MAX_DEPTH = 10;
/** Room kept for the `_trimmed` note itself, so the annotated result still fits. */
const NOTE_RESERVE_CHARS = 700;
/** An object with at least this many keys, most of them objects, is a keyed collection (e.g. a schema's `properties`). */
const COLLECTION_MIN_KEYS = 12;

interface Ctx {
  level: Level;
  dropped: Set<string>;
}

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function shortenString(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isKeyedCollection(obj: Record<string, unknown>): boolean {
  const values = Object.values(obj);
  if (values.length < COLLECTION_MIN_KEYS) return false;
  return values.filter(isPlainObject).length >= values.length * 0.8;
}

function scalar(key: string, v: unknown, ctx: Ctx): Json {
  if (typeof v === 'string') return shortenString(v, /description/i.test(key) ? ctx.level.descriptionMax : ctx.level.stringMax);
  return v as Json;
}

/** Only the identity fields of an object (recursing into JSON:API `attributes`). */
function identityOf(obj: Record<string, unknown>, ctx: Ctx, depth: number): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isIdentityKey(k) && isScalar(v)) out[k] = scalar(k, v, ctx);
    else if (isIdentityKey(k) && Array.isArray(v) && v.every(isScalar) && v.length <= 20) out[k] = v.map((x) => scalar(k, x, ctx));
    else if (k === 'attributes' && isPlainObject(v) && depth < MAX_DEPTH) {
      const inner = identityOf(v, ctx, depth + 1);
      if (Object.keys(inner).length) out[k] = inner;
      for (const ik of Object.keys(v)) if (!(ik in inner)) ctx.dropped.add(`attributes.${ik}`);
    } else ctx.dropped.add(k);
  }
  // Nothing recognisable: keep the first short scalar so the item isn't an empty {}.
  if (Object.keys(out).length === 0) {
    const first = Object.entries(obj).find(([, v]) => isScalar(v));
    if (first) out[first[0]] = scalar(first[0], first[1], ctx);
  }
  return out;
}

/** A list item (or keyed-collection value) at the level's item mode. */
function reduceItem(v: unknown, ctx: Ctx, depth: number): Json {
  if (!isPlainObject(v)) return reduce(v, ctx, depth);
  const mode = ctx.level.item;
  if (mode === 'full') return reduceContainer(v, ctx, depth);
  if (mode === 'identity') return identityOf(v, ctx, depth);
  // shallow: scalars kept, nested objects shrink to identity, nested lists to a count.
  const out: { [k: string]: Json } = {};
  for (const [k, val] of Object.entries(v)) {
    if (isScalar(val)) out[k] = scalar(k, val, ctx);
    else if (isPlainObject(val)) {
      const id = identityOf(val, ctx, depth + 1);
      if (Object.keys(id).length) out[k] = id;
      else ctx.dropped.add(k);
    } else if (Array.isArray(val)) {
      if (val.every(isScalar) && val.length <= 20) out[k] = val.map((x) => scalar(k, x, ctx));
      else {
        out[k] = `[${val.length} item(s) omitted]`;
        ctx.dropped.add(k);
      }
    }
  }
  return out;
}

/** An object that holds results (not itself a list item): every key kept, values reduced. */
function reduceContainer(obj: Record<string, unknown>, ctx: Ctx, depth: number): Json {
  const collection = ctx.level.item !== 'full' && isKeyedCollection(obj);
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = collection ? reduceItem(v, ctx, depth + 1) : reduce(v, ctx, depth + 1, k);
  }
  return out;
}

function reduce(v: unknown, ctx: Ctx, depth: number, key = ''): Json {
  if (depth > MAX_DEPTH) return '[nested too deep — omitted]';
  if (isScalar(v)) return scalar(key, v, ctx);
  if (Array.isArray(v)) {
    if (v.some(isPlainObject)) return v.map((item) => reduceItem(item, ctx, depth + 1));
    return v.map((x) => reduce(x, ctx, depth + 1, key));
  }
  if (isPlainObject(v)) return reduceContainer(v, ctx, depth);
  return null; // undefined, functions, symbols: not JSON
}

/** Level 4: keep the first items of every list longer than `keep`, recording how many were cut. */
function cutLists(v: Json, keep: number, counter: { omitted: number }): Json {
  if (Array.isArray(v)) {
    const kept = v.slice(0, keep).map((x) => cutLists(x, keep, counter));
    if (v.length > keep) {
      counter.omitted += v.length - keep;
      kept.push(`[${v.length - keep} more item(s) omitted — ${v.length} in total]`);
    }
    return kept;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    // A keyed collection (e.g. a schema's `properties` map) is a list too.
    if (isKeyedCollection(v) && entries.length > keep) {
      counter.omitted += entries.length - keep;
      return Object.fromEntries([
        ...entries.slice(0, keep).map(([k, x]) => [k, cutLists(x, keep, counter)]),
        ['_omitted', `${entries.length - keep} more entr(ies) omitted — ${entries.length} in total`],
      ]);
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, cutLists(x, keep, counter)]));
  }
  return v;
}

function annotate(result: Json, note: TrimNote): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) return { _trimmed: note, ...result };
  return { _trimmed: note, items: result };
}

const HOW_TO_GET_MORE =
  'Every item\'s identity fields are kept. For an item\'s full detail, call the matching get/read tool with its id, or pass filter / limit / properties arguments if the tool takes them.';

/**
 * Trim `result` to fit, or return it unchanged when it already fits. The
 * output is always valid JSON (an object; a top-level list is wrapped as
 * `{ _trimmed, items }`).
 */
export function trimResult(result: unknown, opts: TrimOptions): unknown {
  const originalChars = size(result);
  if (result === undefined || originalChars <= opts.maxChars) return result;

  let identity: Json | undefined;
  let dropped = new Set<string>();
  for (const level of LEVELS) {
    const ctx: Ctx = { level, dropped: new Set() };
    const out = reduce(result, ctx, 0);
    const fits = size(out) <= (level.name === 'identity' ? opts.indexMaxChars : opts.maxChars) - NOTE_RESERVE_CHARS;
    if (fits) {
      return annotate(out, {
        originalChars,
        level: level.name,
        ...(ctx.dropped.size ? { droppedFields: [...ctx.dropped].slice(0, 20) } : {}),
        note:
          level.name === 'long-text'
            ? 'Long text values were shortened; nothing else was removed.'
            : `List items were reduced to ${level.name === 'shallow' ? 'their top-level fields' : 'their identity fields'}. ${HOW_TO_GET_MORE}`,
      });
    }
    if (level.name === 'identity') {
      identity = out;
      dropped = ctx.dropped;
    }
  }

  // Level 4: even the identity index is too big. Binary-search the most items per list that fits.
  let lo = 1;
  let hi = 2_000;
  let best: { out: Json; omitted: number } | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const counter = { omitted: 0 };
    const out = cutLists(identity as Json, mid, counter);
    if (size(out) <= opts.indexMaxChars - NOTE_RESERVE_CHARS) {
      best = { out, omitted: counter.omitted };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) {
    // Pathological (one enormous scalar or very wide object): fall back to a valid JSON string preview.
    const json = JSON.stringify(identity) ?? '';
    return annotate(`${json.slice(0, opts.indexMaxChars - NOTE_RESERVE_CHARS)}…`, {
      originalChars,
      level: 'list-cut',
      note: 'The result could not be reduced structurally; this is a text preview of its identity fields.',
    });
  }
  return annotate(best.out, {
    originalChars,
    level: 'list-cut',
    ...(dropped.size ? { droppedFields: [...dropped].slice(0, 20) } : {}),
    omittedItems: best.omitted,
    note:
      `Lists were too long even as an id index: ${best.omitted} item(s) were left out (each list ends with a count). ` +
      'Narrow the call (filters, a name search, paging such as start/limit/page) to reach the rest.',
  });
}
