/**
 * Pre-write check for adobe_create_segment / adobe_update_segment, run before
 * the MCP tool is called (tool-catalog.ts's callTool, next to the pre-commit
 * syntax check).
 *
 * The bug it prevents: a segment whose PQL names a field the sandbox doesn't
 * have. AEP may accept it, and it then qualifies nobody, or the wrong people,
 * while the run reports success. intake_harness verifies every field of a
 * synthesized expression against the sandbox's profile catalog before it is
 * built (pql-synth.ts verifyFields); this is the same check, applied to the
 * agent's own tool call.
 *
 * FAILS OPEN, ON PURPOSE. It only rejects a field it can PROVE is absent:
 *   - the catalog must be complete (every field group read); a partial or
 *     failed read lets the call through, since a missing field group would
 *     otherwise make a real field look invented;
 *   - paths it can't resolve statically (inside `[...]` array filters, under
 *     a `select X from ...` variable, ExperienceEvent `xEvent.*` paths, the
 *     class-level fields and maps) are not judged;
 *   - a path under a known container whose children weren't expanded (an
 *     unresolved data type, a map like segmentMembership) is not judged.
 *
 * What it is NOT: a PQL parser. It doesn't check syntax, operators, types or
 * values; AEP's own validation still does that.
 *
 * SEGMENT_FIELD_CHECK=off disables it without a code change.
 */

import { loadProfileCatalog, type McpCall, type ProfileCatalog } from './profile-catalog';
import { SEGMENT_WRITE_TOOLS } from './segment-context';

/**
 * Class-level and map roots the union's field groups don't describe, or whose
 * children are keyed by data (segment ids, namespaces). Never judged.
 */
const UNJUDGED_ROOTS = new Set([
  'xevent', 'identitymap', 'segmentmembership', '_id', '_repo', 'personid', 'timestamp',
  'createdbybatchid', 'modifiedbybatchid', 'repositorycreatedby', 'repositorylastmodifiedby',
]);

/** PQL words that can sit before a dot and are not field roots. */
const PQL_WORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'select', 'from', 'where', 'in', 'exists', 'all']);

/** The expression with string literals replaced by `""`, so nothing inside quotes reads as a field. */
function stripStrings(pql: string): string {
  return pql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/**
 * Every profile field path an expression references, as written. A trailing
 * method call is not part of the path (`person.birthDate.getAge()` ->
 * `person.birthDate`). Paths inside `[...]` and under variables bound by
 * `select X from` are skipped (see the module comment).
 */
export function extractPqlFieldPaths(pql: string): string[] {
  const text = stripStrings(String(pql || ''));
  const bound = new Set<string>();
  for (const m of text.matchAll(/\bselect\s+([A-Za-z_]\w*)\s+from\b/gi)) bound.add(m[1].toLowerCase());

  const paths = new Set<string>();
  let depth = 0;
  // Identifiers with at least one dot segment: a.b, a.b.c, _tenant.x. A number
  // can't start one, so 1.5 is never a path.
  const re = /\[|\]|(?<![\w.])([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)+)(\s*\()?/g;
  for (const m of text.matchAll(re)) {
    if (m[0] === '[') {
      depth++;
      continue;
    }
    if (m[0] === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    const segments = m[1].split('.').map((s) => s.trim());
    // A trailing `(` means the last segment is a method: drop it. Earlier
    // segments can't be methods here, since `a.f().b` stops the match at `(`.
    if (m[2]) segments.pop();
    if (segments.length === 0) continue;
    const root = segments[0].toLowerCase();
    if (bound.has(root) || PQL_WORDS.has(root)) continue;
    paths.add(segments.join('.'));
  }
  return [...paths];
}

export interface FieldCheck {
  /** Paths the catalog proves are absent. */
  missing: Array<{ path: string; suggestions: string[] }>;
  /** Paths that were not judged (unresolvable statically, or under an unexpanded container). */
  unjudged: string[];
}

/**
 * Judge each referenced path against a COMPLETE catalog. Case-insensitive,
 * whole-path: across ~750 fields a leaf like `address` exists in many places,
 * so a leaf-only match would pass an invented `_tenant.foo.address`.
 */
export function checkFieldPaths(paths: string[], catalog: ProfileCatalog): FieldCheck {
  const known = new Set<string>();
  const parents = new Set<string>();
  for (const f of catalog.fields) {
    const p = f.path.toLowerCase();
    known.add(p);
    const segs = p.split('.');
    for (let i = 1; i < segs.length; i++) parents.add(segs.slice(0, i).join('.'));
  }

  const missing: FieldCheck['missing'] = [];
  const unjudged: string[] = [];
  for (const path of paths) {
    const p = path.toLowerCase();
    const segs = p.split('.');
    if (UNJUDGED_ROOTS.has(segs[0])) {
      unjudged.push(path);
      continue;
    }
    if (known.has(p) || parents.has(p)) continue;
    // Under a known field with no known children: an unexpanded data type or a map. Can't tell.
    let underLeaf = false;
    for (let i = segs.length - 1; i >= 1; i--) {
      const anc = segs.slice(0, i).join('.');
      if (known.has(anc) && !parents.has(anc)) {
        underLeaf = true;
        break;
      }
      if (parents.has(anc)) break;
    }
    if (underLeaf) {
      unjudged.push(path);
      continue;
    }
    missing.push({ path, suggestions: suggest(path, catalog) });
  }
  return { missing, unjudged };
}

/** Up to 3 real paths sharing the missing path's leaf name (case-insensitively), else its leaf as a substring. */
function suggest(path: string, catalog: ProfileCatalog): string[] {
  const leaf = (path.split('.').pop() || path).toLowerCase();
  const exact = catalog.fields.filter((f) => (f.path.split('.').pop() || '').toLowerCase() === leaf);
  const loose = exact.length
    ? exact
    : leaf.length >= 4
      ? catalog.fields.filter((f) => f.type !== 'object' && f.path.toLowerCase().includes(leaf))
      : [];
  return loose.slice(0, 3).map((f) => f.path);
}

function checkEnabled(): boolean {
  return process.env.SEGMENT_FIELD_CHECK?.trim().toLowerCase() !== 'off';
}

/**
 * Throws (no side effects, nothing created) when a segment write's PQL names
 * a field the sandbox provably doesn't have. No-op for every other tool, for
 * a write without a PQL expression, and whenever the catalog can't be read
 * completely.
 */
export async function validateBeforeSegmentWrite(
  toolName: string,
  args: Record<string, unknown>,
  opts: { call?: McpCall; signal?: AbortSignal } = {}
): Promise<void> {
  if (!SEGMENT_WRITE_TOOLS.has(toolName) || !checkEnabled()) return;
  const pql = args.pql_expression;
  if (typeof pql !== 'string' || !pql.trim()) return;

  const paths = extractPqlFieldPaths(pql);
  if (paths.length === 0) return;

  const sandbox = typeof args.sandbox === 'string' && args.sandbox.trim() ? args.sandbox.trim() : undefined;
  const catalog = await loadProfileCatalog(sandbox, opts);
  if (!catalog.complete) {
    console.warn(
      `[segment-validation] ${toolName}: profile catalog incomplete (${catalog.error ?? 'no fields'}); field check skipped`
    );
    return;
  }

  const { missing } = checkFieldPaths(paths, catalog);
  if (missing.length === 0) return;

  const lines = missing.map(
    (m) => `- ${m.path}${m.suggestions.length ? ` (did you mean: ${m.suggestions.join(', ')}?)` : ''}`
  );
  throw new Error(
    `Pre-write segment check failed (validation error) — no segment was ${toolName === 'adobe_create_segment' ? 'created' : 'updated'}. ` +
      `The PQL references field(s) not in the${sandbox ? ` "${sandbox}"` : ''} sandbox's profile schema:\n` +
      `${lines.join('\n')}\n` +
      'Look the fields up with aep_find_profile_fields and use only paths it returns. If a condition in the request has no field at all, do not drop it to make the segment build: create nothing and say which condition has no field.'
  );
}
