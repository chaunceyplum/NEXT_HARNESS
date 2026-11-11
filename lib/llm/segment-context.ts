/**
 * Grounding for AEP segment (audience) work, ported from intake_harness.
 *
 * intake_harness builds noticeably better audiences than this harness did,
 * and most of the difference was grounding, not model quality:
 *
 *   1. It always hands the model the real PQL function reference. The AEP
 *      knowledge base has no PQL syntax at all (see docs/pql-reference.md), so
 *      without it the model writes PQL from memory.
 *   2. It carries the business's own vocabulary (CBM, SEP, ...) and the rules
 *      for reading its Y/N flags, so "Security Edge Preferred customers" maps
 *      to a field titled "Has SEP" and comes out as `= "Y"`, not `= true`.
 *   3. It forbids silently narrowing an audience when one condition has no
 *      field, which otherwise produces a wrong (broader) segment that looks right.
 *
 * This module is the prompt half of that (segmentDomainContext, injected into
 * the cached system prompt on segment runs only, the same way the Launch
 * context is gated on Launch runs), plus the business-word field search the
 * aep_find_profile_fields tool runs. The enforcement half - rejecting PQL that
 * names a field the sandbox doesn't have - is segment-validation.ts.
 */

import { PQL_REFERENCE } from './pql-reference';
import type { ProfileField } from './profile-catalog';

// ── Business glossary ─────────────────────────────────────────────────────────

/**
 * The business's own vocabulary. Field titles use its abbreviations ("Has
 * SEP", "Is CBM member"); marketers write either form. Without this the model
 * could not connect the two (intake_harness plain-language eval, 26 Sep 2026:
 * 6/17 briefs passed before the glossary was added).
 *
 * Tenant-specific DATA, not logic: edit here when the business adds a product
 * or an abbreviation. Kept in step with intake_harness's glossary.ts.
 */
export const BUSINESS_GLOSSARY: ReadonlyArray<{ term: string; meaning: string }> = [
  { term: 'CB', meaning: 'Comcast Business' },
  { term: 'CBM', meaning: 'Comcast Business Mobile' },
  { term: 'CB Internet', meaning: 'Comcast Business Internet' },
  { term: 'SEP', meaning: 'Security Edge Preferred, a Comcast Business security product' },
];

/** How this business's profiles and flags are meant to be read. */
export const BUSINESS_CONTEXT: readonly string[] = [
  'Profiles are contacts at Comcast Business customer companies. Company-level attributes (Company Size is ' +
    'the number of employees) and product flags live on the profile itself, so "companies/businesses with ..." ' +
    'selects profiles whose attributes match - it is not a separate entity.',
  'An unqualified product word means the Comcast Business product: "mobile" is CBM, "internet" is CB Internet.',
  'Y/N flags: what the marketer asks for is = "Y" ("has SEP" -> hasSEP = "Y"); its opposite is = "N" ' +
    '("doesn\'t have SEP" -> hasSEP = "N"; "email is not valid" / "invalid email" -> validEmailFlag = "N"). ' +
    'Being eligible for a product is its eligibility flag.',
  'The product flags (Is CBM member, Is CB Internet Member, Has SEP) ARE the customer status for those products: ' +
    '"customers of / members of / subscribers to / has X" is that flag = "Y". There is no separate ' +
    'subscription or active-service field to look for.',
  'Only when EXCLUDING people who carry a flag ("excluding do not contact", "not on the do-not-contact list") ' +
    'write != "Y" (doNotContact != "Y"), so profiles with no value stay in. Never write != "N" - it selects ' +
    'the opposite of a "not ..." request.',
  '"Valid email" / "emailable" / "people we can email" is validEmailFlag = "Y" - the flag already ' +
    'implies an address, so no separate email field is needed. "People we can contact / email" also means ' +
    'doNotContact != "Y". Those two flags ARE this business\'s rule for who may be emailed - do not look for ' +
    'a separate consent or opt-in field.',
  '"Allowed to contact" / "contactable" / "can contact" is doNotContact != "Y" - that flag IS the ' +
    'contact permission; there is no other permission field to find.',
];

export function glossaryPrompt(): string {
  return [
    'Business glossary (the marketer may use either form):',
    ...BUSINESS_GLOSSARY.map((g) => `- ${g.term} = ${g.meaning}`),
    'How to read this business\'s data:',
    ...BUSINESS_CONTEXT.map((c) => `- ${c}`),
  ].join('\n');
}

// ── Segment mode ──────────────────────────────────────────────────────────────

/** Tools that write a segment's PQL. Their arguments are checked by segment-validation.ts. */
export const SEGMENT_WRITE_TOOLS = new Set(['adobe_create_segment', 'adobe_update_segment']);

/**
 * Added to the always-on tool set on segment runs, so they don't have to win
 * a shortlist slot on embedding similarity. The field lookup is what makes
 * the "only real fields" rule practical; the writes are what the run is for.
 */
export const SEGMENT_ALWAYS_ON_TOOLS = ['aep_find_profile_fields', 'adobe_create_segment', 'adobe_update_segment', 'adobe_list_segments'];

const SEGMENT_REQUEST = /\b(segments?|audiences?|pql|segmentation)\b/i;

/**
 * Whether this run gets the segment grounding: explicit opts.segmentMode wins;
 * otherwise a request that talks about segments, audiences or PQL. Matched on
 * the request text (not the shortlist) so the eval path, which passes its own
 * tools, is grounded the same way a live run is.
 */
export function resolveSegmentMode(opts: { segmentMode?: boolean }, userInput: string): boolean {
  if (opts.segmentMode !== undefined) return opts.segmentMode;
  return SEGMENT_REQUEST.test(userInput);
}

/**
 * The segment-run block of the system prompt. Stable text (no per-request
 * data), so it rides the cached prefix like the Launch context does.
 */
export function segmentDomainContext(): string {
  return [
    'AEP segments / audiences — ground every segment definition in the sandbox\'s real fields and real PQL:',
    '- Before writing or changing a segment\'s PQL, look up the fields it needs with aep_find_profile_fields (search by the business words in the request, e.g. "CBM member", "SEP eligible", "company size"). If that tool is unavailable, read the profile union with adobe_get_union_schema (class_id https://ns.adobe.com/xdm/context/profile) and the field groups it lists.',
    '- Use ONLY field paths the sandbox actually has. Never reference a field because it seems obvious it should exist. adobe_create_segment and adobe_update_segment are checked before they run: an expression naming a field the sandbox does not have is rejected, and nothing is created.',
    '- The request is in business language, not field names. Match its words to fields by TITLE and DESCRIPTION as well as path ("customers who have CBM" means a field titled "Is CBM member"). Prefer the tenant\'s own fields (_<tenant>.*) over standard XDM fields when both fit.',
    '- Compare to the values the field actually holds: a string described as a Y/N flag is = "Y", a boolean is = true, an enum uses one of its listed values. "Has an email" means the field exists (X.isNotNull()). Fields inside an array need the array syntax from the PQL reference, not a plain dotted comparison.',
    '- Use ONLY PQL syntax from the PQL reference below.',
    '- The expression MUST capture EVERY condition in the request. If even one condition (a region, a recency threshold, an exclusion, an eligibility flag, ...) has no field to express it, do NOT create a narrower segment from the conditions you could match: a segment for a broader audience is a wrong answer, not a partial one. Create nothing, and in your final answer list every condition you could not express and ask how to handle it.',
    '- Before creating, check adobe_list_segments for one that already matches the request; reuse it rather than creating a duplicate, and say so.',
    '- In your final answer, state the rule in plain English (e.g. "profiles whose Is CBM member flag is Y and who are not on the do-not-contact list") next to the PQL, so the person who asked can check it.',
    '',
    glossaryPrompt(),
    '',
    'PQL reference (Adobe\'s own function reference; the knowledge base does not have it):',
    PQL_REFERENCE,
  ].join('\n');
}

// ── Business-word field search (aep_find_profile_fields) ─────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'who', 'are', 'has', 'have', 'not', 'flag', 'field',
  'customers', 'customer', 'profile', 'profiles', 'audience', 'people', 'anyone', 'everyone', 'whose', 'all',
  'segment', 'create', 'build', 'want', 'need',
]);

/** Lower-case word stems: camelCase split, plurals folded ("companies" -> "company"). */
function stems(text: string): string[] {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** The query's stems, plus both forms of every glossary entry it uses ("Security Edge Preferred" also brings "sep"). */
function queryStems(query: string): Set<string> {
  const out = new Set(stems(query));
  const lower = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const g of BUSINESS_GLOSSARY) {
    const meaning = g.meaning.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (lower.includes(` ${g.term.toLowerCase()} `) || lower.includes(` ${meaning} `)) {
      [...stems(g.term), ...stems(meaning), g.term.toLowerCase()].forEach((w) => out.add(w));
    }
  }
  return out;
}

export interface FieldMatch {
  path: string;
  type: string | null;
  title?: string;
  description?: string;
  values?: string[];
}

/**
 * The catalog's best matches for a business-language query. Scores a field by
 * how many query stems its path and title share (weighted) and its
 * description (lighter); tenant fields win ties. Deprecated fields and plain
 * containers are left out - a rule never compares against those.
 */
export function searchProfileFields(fields: ProfileField[], query: string, limit = 15): FieldMatch[] {
  const wanted = queryStems(query);
  if (wanted.size === 0) return [];
  const scored: Array<{ f: ProfileField; score: number }> = [];
  for (const f of fields) {
    if (f.deprecated || f.type === 'object') continue;
    const name = new Set([...stems(f.path.split('.').pop() || f.path), ...stems(f.title ?? '')]);
    const desc = new Set(stems(f.description ?? ''));
    let score = 0;
    for (const w of wanted) {
      if (name.has(w)) score += 3;
      else if (desc.has(w)) score += 1;
    }
    if (score === 0) continue;
    if (f.path.startsWith('_')) score += 0.5;
    scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(({ f }) => ({
      path: f.path,
      type: f.type,
      ...(f.title ? { title: f.title } : {}),
      ...(f.description ? { description: f.description.slice(0, 160) } : {}),
      ...(f.values?.length ? { values: f.values.slice(0, 20) } : {}),
    }));
}
