/**
 * The sandbox's real profile field catalog: every field PQL can address,
 * with its full dotted path, XDM type, title, description and allowed values.
 *
 * Ported from intake_harness (src/lib/agents/audience/aep.ts, buildCatalog),
 * where it is what lets a plain-English audience brief find its fields and
 * what PQL is verified against. Two consumers here:
 *
 *   - segment-validation.ts rejects an adobe_create_segment / update_segment
 *     whose PQL references a field this catalog does not have.
 *   - the aep_find_profile_fields local tool (local-tools.ts) lets the agent
 *     look fields up by business words ("CBM member") instead of guessing.
 *
 * WHY IT IS BUILT FROM FIELD GROUPS: adobe_get_union_schema for the profile
 * class comes back (checked live, Nov 2026) as ~95 `allOf` $refs to field
 * groups with no inline properties. Reading the union alone finds nothing.
 * So the catalog opens each referenced field group, then follows data-type
 * links (`homeAddress` -> xdm/common/address) a couple of levels deep.
 *
 * COMPLETENESS IS TRACKED, because the validator must never reject a real
 * field just because one field-group fetch failed. `complete` is true only
 * when every listed field group was read. Only complete catalogs are cached.
 */

import { callMcpTool } from '@/lib/mcp-client';

export const PROFILE_UNION_CLASS = 'https://ns.adobe.com/xdm/context/profile';

export interface ProfileField {
  path: string;
  type: string | null;
  title?: string | null;
  description?: string | null;
  /** Allowed values when the schema enumerates them (`meta:enum` labels, else `enum`). */
  values?: string[] | null;
  deprecated?: boolean;
}

export interface ProfileCatalog {
  /** Every field group the union listed was read. A validator only rejects against a complete catalog. */
  complete: boolean;
  fields: ProfileField[];
  /** How many field groups were opened. */
  groupsOpened: number;
  /** Last error seen while building, when any read failed. */
  error: string | null;
}

/** An injectable MCP call, so tests (and evals) can script the platform. */
export type McpCall = (toolName: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown>;

const FETCH_CONCURRENCY = 8;
const FIELD_GROUP_CAP = 250;
const DATA_TYPE_DEPTH = 2;
const CACHE_MS = 10 * 60_000;

const cache = new Map<string, { at: number; catalog: ProfileCatalog }>();
/** Builds in progress, so concurrent runs on a cold cache share one (~100 reads) instead of each flooding the gateway. */
const inflight = new Map<string, Promise<ProfileCatalog>>();

/** Test hook. */
export function clearProfileCatalogCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Every field under a schema / field-group / data-type document, with its full
 * dotted path, plus the data-type `$ref` links it could not expand itself.
 * Path segments come from `properties` keys only, so wrappers like
 * `definitions.customFields` and `allOf` never leak into a path.
 */
export function walkFields(
  schema: unknown,
  prefix = ''
): { fields: ProfileField[]; refs: Array<{ path: string; ref: string }> } {
  const out = new Map<string, ProfileField>();
  const refs: Array<{ path: string; ref: string }> = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (depth > 16 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, at, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    const props = o.properties;
    if (props && typeof props === 'object') {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        const path = at ? `${at}.${key}` : key;
        const c = (child && typeof child === 'object' ? child : {}) as Record<string, unknown>;
        if (!out.has(path)) {
          const labels =
            c['meta:enum'] && typeof c['meta:enum'] === 'object'
              ? Object.keys(c['meta:enum'] as Record<string, unknown>)
              : Array.isArray(c.enum)
                ? (c.enum as unknown[]).map(String)
                : [];
          out.set(path, {
            path,
            type: String(c['meta:xdmType'] ?? c.type ?? '') || null,
            description: String(c.description ?? '').trim() || null,
            title: String(c.title ?? '').trim() || null,
            values: labels.length ? labels : null,
            ...(c['meta:status'] === 'deprecated' ? { deprecated: true } : {}),
          });
        }
        const items = c.items && typeof c.items === 'object' ? (c.items as Record<string, unknown>) : null;
        const ref = typeof c.$ref === 'string' ? c.$ref : typeof items?.$ref === 'string' ? String(items.$ref) : '';
        if (ref && !c.properties && !items?.properties) refs.push({ path, ref });
        walk(child, path, depth + 1);
      }
    }
    for (const [key, val] of Object.entries(o)) {
      if (key !== 'properties' && val && typeof val === 'object') walk(val, at, depth + 1);
    }
  };
  walk(schema, prefix, 0);
  return { fields: [...out.values()], refs };
}

/**
 * The field-group `$ref`s a union view composes via `allOf`. The Profile
 * class itself and xdm/data/* are not fetchable as field groups, so they are
 * skipped; their few class-level fields are allow-listed by the validator.
 */
export function fieldGroupRefs(union: unknown): string[] {
  const refs = new Set<string>();
  const skip = (ref: string) => /ns\.adobe\.com\/xdm\/data\//.test(ref) || /ns\.adobe\.com\/xdm\/context\/profile$/.test(ref);
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    // meta:extends lists schemas as well as field groups; only allOf is the composition.
    if (typeof o.$ref === 'string' && o.$ref && !o.$ref.startsWith('#') && !skip(o.$ref)) refs.add(o.$ref);
    for (const [key, val] of Object.entries(o)) if (key !== 'meta:extends') walk(val, depth + 1);
  };
  walk(union);
  return [...refs];
}

async function fetchAll(
  call: McpCall,
  tool: 'adobe_get_field_group' | 'adobe_get_data_type',
  ids: string[],
  sandbox: string | undefined,
  signal?: AbortSignal
): Promise<{ docs: Array<{ id: string; doc: unknown }>; error: string | null }> {
  const docs: Array<{ id: string; doc: unknown }> = [];
  let error: string | null = null;
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const slice = ids.slice(i, i + FETCH_CONCURRENCY);
    const batch = await Promise.allSettled(
      slice.map((id) =>
        call(
          tool,
          {
            ...(tool === 'adobe_get_field_group' ? { field_group_id: id } : { data_type_id: id }),
            ...(sandbox ? { sandbox } : {}),
          },
          { signal }
        )
      )
    );
    batch.forEach((r, j) => {
      if (r.status === 'fulfilled') docs.push({ id: slice[j], doc: r.value });
      else error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    });
  }
  return { docs, error };
}

async function build(call: McpCall, sandbox: string | undefined, signal?: AbortSignal): Promise<ProfileCatalog> {
  let union: unknown;
  try {
    union = await call('adobe_get_union_schema', { class_id: PROFILE_UNION_CLASS, ...(sandbox ? { sandbox } : {}) }, { signal });
  } catch (err) {
    return { complete: false, fields: [], groupsOpened: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const out = new Map<string, ProfileField>();
  let pending: Array<{ path: string; ref: string }> = [];
  const inline = walkFields(union);
  inline.fields.forEach((f) => out.set(f.path, f));
  pending.push(...inline.refs);

  const groupIds = fieldGroupRefs(union);
  const truncated = groupIds.length > FIELD_GROUP_CAP;
  const groups = await fetchAll(call, 'adobe_get_field_group', groupIds.slice(0, FIELD_GROUP_CAP), sandbox, signal);
  for (const { doc } of groups.docs) {
    const walked = walkFields(doc);
    walked.fields.forEach((f) => {
      if (!out.has(f.path)) out.set(f.path, f);
    });
    pending.push(...walked.refs);
  }

  // Data-type links are best-effort: an unresolved one leaves its parent as a
  // known container with no known children, which the validator treats as
  // "can't tell", never as missing. So they don't affect `complete`.
  const typeDocs = new Map<string, unknown>();
  for (let depth = 0; depth < DATA_TYPE_DEPTH && pending.length; depth++) {
    const unseen = [...new Set(pending.map((p) => p.ref))].filter((r) => !typeDocs.has(r));
    const fetched = await fetchAll(call, 'adobe_get_data_type', unseen, sandbox, signal);
    fetched.docs.forEach(({ id, doc }) => typeDocs.set(id, doc));
    const next: Array<{ path: string; ref: string }> = [];
    for (const { path, ref } of pending) {
      const doc = typeDocs.get(ref);
      if (!doc) continue;
      const walked = walkFields(doc, path);
      walked.fields.forEach((f) => {
        if (!out.has(f.path)) out.set(f.path, f);
      });
      next.push(...walked.refs);
    }
    pending = next;
  }

  const complete = !groups.error && !truncated && out.size > 0;
  return {
    complete,
    fields: [...out.values()],
    groupsOpened: groups.docs.length,
    error: groups.error ?? (truncated ? `union lists ${groupIds.length} field groups; only ${FIELD_GROUP_CAP} were read` : null),
  };
}

/**
 * The profile catalog for `sandbox` (undefined = the MCP server's default),
 * from cache when a complete one is fresh. Never throws: a failed read comes
 * back as an incomplete, possibly empty, catalog with the error.
 */
export async function loadProfileCatalog(
  sandbox?: string,
  opts: { call?: McpCall; signal?: AbortSignal } = {}
): Promise<ProfileCatalog> {
  const key = sandbox?.trim() || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.catalog;
  const running = inflight.get(key);
  if (running) return running;
  const call: McpCall = opts.call ?? ((name, args, o) => callMcpTool(name, args, o));
  const p = build(call, key || undefined, opts.signal)
    .then((catalog) => {
      if (catalog.complete) cache.set(key, { at: Date.now(), catalog });
      return catalog;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
