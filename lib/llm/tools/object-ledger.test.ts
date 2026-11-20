import { describe, expect, it } from 'vitest';
import { tool, jsonSchema, type ModelMessage, type ToolSet } from 'ai';
import { describeObjects, extractObjects, kindFromToolName, ObjectLedger, recallObjectsTool, withObjectLedger } from './object-ledger';
import { trimResult } from './result-trim';
import { compressOldToolMessages } from '../runtime/context-compression';

const exec = (t: unknown, input: unknown) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 'c1', messages: [] });

const schemaList = {
  results: [
    { $id: 'https://ns.adobe.com/acme/schemas/aaa', title: 'Web Interactions', 'meta:class': 'https://ns.adobe.com/xdm/context/experienceevent' },
    { $id: 'https://ns.adobe.com/acme/schemas/bbb', title: 'Email Click Events', 'meta:class': 'https://ns.adobe.com/xdm/context/experienceevent' },
  ],
  _page: { count: 2 },
};

const reactorRules = {
  data: [
    { id: 'RL1', type: 'rules', attributes: { name: 'Page Load' }, relationships: { property: { data: { id: 'PR9', type: 'properties' } } } },
    { id: 'RL2', type: 'rules', attributes: { name: 'Click' } },
  ],
};

describe('kindFromToolName', () => {
  it('takes the noun after the verb', () => {
    expect(kindFromToolName('adobe_list_schemas')).toBe('schemas');
    expect(kindFromToolName('reactor_get_rule')).toBe('rule');
    expect(kindFromToolName('cja_list_data_views')).toBe('data_views');
    expect(kindFromToolName('policy_info')).toBeUndefined();
  });
});

describe('extractObjects', () => {
  it('reads AEP $id + title', () => {
    expect(extractObjects(schemaList, 'adobe_list_schemas')).toEqual([
      { id: 'https://ns.adobe.com/acme/schemas/aaa', label: 'Web Interactions', kind: 'schemas' },
      { id: 'https://ns.adobe.com/acme/schemas/bbb', label: 'Email Click Events', kind: 'schemas' },
    ]);
  });

  it('reads Reactor JSON:API ids, attribute names, types and related ids', () => {
    const objs = extractObjects(reactorRules, 'reactor_list_rules');
    expect(objs).toEqual(
      expect.arrayContaining([
        { id: 'RL1', label: 'Page Load', kind: 'rules' },
        { id: 'PR9', kind: 'properties' },
        { id: 'RL2', label: 'Click', kind: 'rules' },
      ])
    );
  });

  it('still finds every id in a trimmed result, and ignores the _trimmed note', () => {
    const big = { results: Array.from({ length: 150 }, (_, i) => ({ $id: `s${i}`, title: `Schema ${i}`, properties: { x: 'y'.repeat(400) } })) };
    const trimmed = trimResult(big, { maxChars: 10_000, indexMaxChars: 20_000 });
    const ids = extractObjects(trimmed, 'adobe_list_schemas').map((o) => o.id);
    expect(ids).toHaveLength(150);
    expect(ids.at(-1)).toBe('s149');
  });

  it('does not take JSON Schema "type" keywords for a kind', () => {
    expect(extractObjects({ id: 'f1', type: 'string', title: 'Tier' }, 'adobe_get_field_group')[0].kind).toBe('field_group');
  });
});

describe('ObjectLedger', () => {
  it('dedupes by id and lets a later sighting fill in the label', () => {
    const ledger = new ObjectLedger();
    expect(ledger.record('reactor_list_rules', reactorRules)).toBe(3);
    expect(ledger.record('reactor_get_property', { data: { id: 'PR9', type: 'properties', attributes: { name: 'Web Prop' } } })).toBe(0);
    expect(ledger.entries('PR9')).toEqual([{ id: 'PR9', label: 'Web Prop', kind: 'properties', tool: 'reactor_get_property' }]);
    expect(ledger.size).toBe(3);
  });

  it('skips synthetic tools', () => {
    const ledger = new ObjectLedger();
    ledger.record('update_plan', { id: 3 });
    ledger.record('recall_objects', { objects: [{ id: 'x' }] });
    expect(ledger.size).toBe(0);
  });

  it('filters by every word of a query across id, label, kind and tool', () => {
    const ledger = new ObjectLedger();
    ledger.record('adobe_list_schemas', schemaList);
    expect(ledger.entries('email schemas').map((e) => e.label)).toEqual(['Email Click Events']);
    expect(ledger.entries('nothing-like-this')).toEqual([]);
  });
});

describe('withObjectLedger', () => {
  const lister = tool({ description: 'list', inputSchema: jsonSchema({ type: 'object' }), execute: async () => schemaList });

  it('records results of direct calls and of calls proxied through call_tool, under the real tool name', async () => {
    const ledger = new ObjectLedger();
    const callTool = tool({ description: 'proxy', inputSchema: jsonSchema({ type: 'object' }), execute: async () => reactorRules });
    const tools: ToolSet = withObjectLedger({ adobe_list_schemas: lister, call_tool: callTool }, ledger);

    expect(await exec(tools.adobe_list_schemas, {})).toBe(schemaList); // result unchanged
    await exec(tools.call_tool, { tool_name: 'reactor_list_rules', arguments: {} });
    expect(ledger.entries('rules').every((e) => e.tool === 'reactor_list_rules')).toBe(true);
    expect(ledger.size).toBe(5);
  });
});

describe('recall_objects', () => {
  it('returns matching entries in first-seen order, the most recent when limited, with a total', async () => {
    const ledger = new ObjectLedger();
    ledger.record('adobe_list_schemas', schemaList);
    ledger.record('reactor_list_rules', reactorRules);
    const out = (await exec(recallObjectsTool(ledger), { query: 'rules', limit: 1 })) as { total: number; shown: number; objects: Array<{ id: string }>; note: string };
    // RL1, PR9 (seen through reactor_list_rules, which the query also matches) and RL2.
    expect(out.total).toBe(3);
    expect(out.shown).toBe(1);
    expect(out.objects[0].id).toBe('RL2');
    expect(out.note).toMatch(/1 most recent of 3/);
  });

  it('says so when nothing has been seen yet', async () => {
    const out = (await exec(recallObjectsTool(new ObjectLedger()), {})) as { note: string };
    expect(out.note).toMatch(/No tool result has shown any object yet/);
  });
});

describe('compression placeholders', () => {
  /** n tool-call/tool-result pairs, each a 2-schema list padded past the 500-char floor. */
  function history(n: number): ModelMessage[] {
    const msgs: ModelMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'adobe_list_schemas', input: { page: i } }] });
      msgs.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'adobe_list_schemas', output: { type: 'json', value: { ...schemaList, pad: 'p'.repeat(600) } } }],
      });
    }
    return msgs;
  }

  it('name the ids the compressed result held and point at recall_objects', () => {
    const compressed: string[] = [];
    const out = compressOldToolMessages(history(8), 8, { recall: true, onCompressed: (id) => compressed.push(id) })!;
    const first = (out[2] as { content: Array<{ output: { value: string } }> }).content[0].output.value;
    expect(first).toMatch(/^\[compressed to save context\]/);
    expect(first).toContain('https://ns.adobe.com/acme/schemas/aaa ("Web Interactions")');
    expect(first).toContain('call recall_objects');
    expect(compressed).toEqual(['c0', 'c1', 'c2', 'c3']);
    // The 4 newest results are untouched.
    expect(JSON.stringify(out.at(-1))).not.toContain('[compressed');
  });

  it('keep the re-fetch hint when recall_objects is not available', () => {
    const out = compressOldToolMessages(history(8), 8)!;
    const first = (out[2] as { content: Array<{ output: { value: string } }> }).content[0].output.value;
    expect(first).toContain('Re-fetch');
    expect(first).toContain('Email Click Events');
  });
});

describe('describeObjects', () => {
  it('caps the list and counts the rest', () => {
    const objs = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, label: `Label ${i}` }));
    const line = describeObjects(objs, 100);
    expect(line).toMatch(/^It held 100 object\(s\): id-0 \("Label 0"\)/);
    expect(line).toMatch(/\+\d+ more\.$/);
  });
});
