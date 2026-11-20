import { describe, expect, it } from 'vitest';
import { trimResult, type TrimNote } from './result-trim';

const LIMITS = { maxChars: 10_000, indexMaxChars: 20_000 };

/** An AEP Schema Registry list page with full schema bodies, the shape that used to be sliced mid-JSON. */
function aepSchemaList(n: number) {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      $id: `https://ns.adobe.com/acme/schemas/${(i + 1).toString(16).padStart(32, '0')}`,
      'meta:altId': `_acme.schemas.${(i + 1).toString(16).padStart(32, '0')}`,
      title: `Schema ${i + 1}`,
      description: `Schema ${i + 1} holds data for a business unit. `.repeat(6),
      'meta:class': i % 2 ? 'https://ns.adobe.com/xdm/context/profile' : 'https://ns.adobe.com/xdm/context/experienceevent',
      version: '1.2',
      allOf: [{ $ref: 'https://ns.adobe.com/xdm/context/profile' }, { $ref: 'https://ns.adobe.com/acme/mixins/loyalty' }],
      properties: { _acme: { type: 'object', properties: { loyalty: { type: 'object', properties: { tier: { type: 'string' } } } } } },
      'meta:extends': ['https://ns.adobe.com/xdm/context/profile', 'https://ns.adobe.com/xdm/data/record'],
    })),
    _page: { orderby: 'title', next: null, count: n },
  };
}

/** A Reactor (JSON:API) rules list. */
function reactorRules(n: number) {
  return {
    data: Array.from({ length: n }, (_, i) => ({
      id: `RL${String(i).padStart(30, 'a')}`,
      type: 'rules',
      attributes: {
        name: `Rule ${i}`,
        enabled: i % 3 !== 0,
        created_at: '2026-10-01T00:00:00Z',
        revision_number: i,
        published: false,
        review_status: 'unsubmitted',
        dirty: true,
      },
      relationships: { property: { data: { id: 'PR123', type: 'properties' } }, rule_components: { links: { related: `https://reactor.adobe.io/rules/RL${i}/rule_components` } } },
      links: { self: `https://reactor.adobe.io/rules/RL${i}`, property: 'https://reactor.adobe.io/properties/PR123' },
      meta: { latest_revision: { id: `RL${i}r`, number: i } },
    })),
    meta: { pagination: { current_page: 1, total_count: n } },
  };
}

const noteOf = (v: unknown) => (v as { _trimmed: TrimNote })._trimmed;

describe('trimResult', () => {
  it('returns results that fit unchanged (same reference)', () => {
    const small = { id: 'x', name: 'small' };
    expect(trimResult(small, LIMITS)).toBe(small);
    expect(trimResult(undefined, LIMITS)).toBeUndefined();
  });

  it('keeps every schema id and title of a 60-schema list instead of slicing the JSON', () => {
    const list = aepSchemaList(60);
    expect(JSON.stringify(list).length).toBeGreaterThan(50_000);
    const out = trimResult(list, LIMITS) as { results: Array<Record<string, unknown>> };

    // Valid, object-shaped output with every item present.
    expect(typeof out).toBe('object');
    expect(out.results).toHaveLength(60);
    for (let i = 0; i < 60; i++) {
      expect(out.results[i].$id).toBe(list.results[i].$id);
      expect(out.results[i].title).toBe(`Schema ${i + 1}`);
      expect(out.results[i]['meta:class']).toBe(list.results[i]['meta:class']);
    }
    const note = noteOf(out);
    expect(note.originalChars).toBe(JSON.stringify(list).length);
    expect(['shallow', 'identity']).toContain(note.level);
    expect(note.droppedFields).toEqual(expect.arrayContaining(['properties']));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.indexMaxChars);
  });

  it('keeps Reactor JSON:API ids and attribute names', () => {
    const rules = reactorRules(80);
    const out = trimResult(rules, LIMITS) as { data: Array<{ id: string; type: string; attributes?: { name?: string; enabled?: boolean } }> };
    expect(out.data).toHaveLength(80);
    expect(out.data[5]).toMatchObject({ id: rules.data[5].id, type: 'rules', attributes: { name: 'Rule 5' } });
    expect(out.data[0].attributes?.enabled).toBe(false);
    expect(out.data[1].attributes?.enabled).toBe(true);
  });

  it('only shortens long text when that is enough', () => {
    const doc = { id: 'p1', name: 'Project', definition: 'x'.repeat(12_000) };
    const out = trimResult(doc, LIMITS) as Record<string, string>;
    expect(out.id).toBe('p1');
    expect(out.definition).toMatch(/^x{400}…\(\+11600 chars\)$/);
    expect(noteOf(out).level).toBe('long-text');
  });

  it('treats a wide map of objects (a schema\'s properties) as a collection of items', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`field${i}`, { title: `Field ${i}`, type: 'string', description: 'd'.repeat(80), 'meta:xdmField': `_acme.field${i}`, enum: ['a', 'b', 'c'] }])
    );
    const out = trimResult({ $id: 'https://ns.adobe.com/acme/schemas/s1', title: 'Big', properties }, LIMITS) as {
      $id: string;
      properties: Record<string, { title?: string; type?: string }>;
    };
    expect(out.$id).toBe('https://ns.adobe.com/acme/schemas/s1');
    // 1,000 fields don't fit even as identity-only entries, so the map is cut and says so.
    expect(out.properties.field0).toMatchObject({ title: 'Field 0', type: 'string' });
    expect(String(out.properties._omitted)).toMatch(/more entr\(ies\) omitted — 1000 in total/);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.indexMaxChars);
  });

  it('keeps every entry of a moderately wide map at identity level', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`field${i}`, { title: `Field ${i}`, type: 'string', 'meta:xdmField': `_acme.field${i}`, enum: ['a', 'b'], description: 'd'.repeat(300) }])
    );
    const out = trimResult({ title: 'Mid', properties }, LIMITS) as { properties: Record<string, { title?: string }> };
    expect(Object.keys(out.properties)).toHaveLength(300);
    expect(out.properties.field299.title).toBe('Field 299');
  });

  it('cuts list length only as a last resort, and says how many items were left out', () => {
    const list = aepSchemaList(400);
    const out = trimResult(list, LIMITS) as { results: unknown[] };
    const note = noteOf(out);
    expect(note.level).toBe('list-cut');
    expect(note.omittedItems).toBeGreaterThan(0);
    const last = out.results[out.results.length - 1];
    expect(last).toMatch(/more item\(s\) omitted — 400 in total/);
    expect(out.results.length - 1 + (note.omittedItems ?? 0)).toBe(400);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.indexMaxChars);
  });

  it('wraps a top-level array so the result stays an object', () => {
    const segments = Array.from({ length: 200 }, (_, i) => ({ id: `seg-${i}`, name: `Segment ${i}`, expression: { type: 'PQL', value: 'x'.repeat(300) } }));
    const out = trimResult(segments, LIMITS) as { _trimmed: TrimNote; items: Array<{ id: string; name: string }> };
    expect(out.items).toHaveLength(200);
    expect(out.items[199]).toMatchObject({ id: 'seg-199', name: 'Segment 199' });
  });

  it('always produces output that round-trips through JSON', () => {
    for (const input of [aepSchemaList(30), aepSchemaList(500), reactorRules(300), { blob: 'y'.repeat(50_000) }]) {
      const out = trimResult(input, LIMITS);
      expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.indexMaxChars);
    }
  });
});
