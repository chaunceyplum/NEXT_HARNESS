import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PQL_REFERENCE } from './pql-reference';
import { resolveSegmentMode, searchProfileFields, segmentDomainContext } from './segment-context';
import { systemPrompt } from './agent-core';
import type { ProfileField } from './profile-catalog';

describe('PQL reference', () => {
  it('matches docs/pql-reference.md (run node scripts/gen-pql-reference.mjs after editing it)', () => {
    expect(PQL_REFERENCE).toBe(readFileSync(join(__dirname, '../../docs/pql-reference.md'), 'utf8'));
  });
});

describe('resolveSegmentMode', () => {
  it('turns on for requests about segments, audiences or PQL', () => {
    expect(resolveSegmentMode({}, 'Build an audience of Security Edge Preferred customers')).toBe(true);
    expect(resolveSegmentMode({}, 'Show me the PQL for the Gold VIP segment')).toBe(true);
  });

  it('stays off otherwise, and an explicit option wins', () => {
    expect(resolveSegmentMode({}, 'Create a Launch rule that fires on click')).toBe(false);
    expect(resolveSegmentMode({ segmentMode: false }, 'Create a segment')).toBe(false);
    expect(resolveSegmentMode({ segmentMode: true }, 'anything')).toBe(true);
  });
});

describe('systemPrompt segment grounding', () => {
  it('is added only on segment runs', () => {
    const plain = systemPrompt({});
    const segment = systemPrompt({ segmentMode: true });
    expect(plain).not.toContain('PQL reference');
    expect(segment).toContain(segmentDomainContext());
    expect(segment).toContain('SEP = Security Edge Preferred');
    expect(segment).toContain('aep_find_profile_fields');
  });
});

describe('searchProfileFields', () => {
  const fields: ProfileField[] = [
    { path: '_tenant.isCBMmember', type: 'string', title: 'Is CBM member', description: 'Y/N flag' },
    { path: '_tenant.hasSEP', type: 'string', title: 'Has SEP', description: 'Y/N flag' },
    { path: '_tenant.SEPeligible', type: 'string', title: 'SEP eligible', description: 'Y/N flag' },
    { path: '_tenant.companySize', type: 'integer', title: 'Company Size', description: 'Number of employees' },
    { path: 'person.name.firstName', type: 'string', title: 'First name' },
    { path: '_tenant.oldFlag', type: 'string', title: 'SEP legacy', deprecated: true },
    { path: '_tenant', type: 'object', title: 'Tenant SEP container' },
  ];

  it('maps spelled-out product names to abbreviated field titles via the glossary', () => {
    const paths = searchProfileFields(fields, 'Security Edge Preferred customers').map((m) => m.path);
    expect(paths.slice(0, 2).sort()).toEqual(['_tenant.SEPeligible', '_tenant.hasSEP']);
    expect(paths).not.toContain('_tenant.oldFlag');
    expect(paths).not.toContain('_tenant');
  });

  it('finds fields by title and description words', () => {
    expect(searchProfileFields(fields, 'companies with more than 50 employees')[0].path).toBe('_tenant.companySize');
    expect(searchProfileFields(fields, 'Comcast Business Mobile members')[0].path).toBe('_tenant.isCBMmember');
  });

  it('returns nothing for a query with no usable words', () => {
    expect(searchProfileFields(fields, 'the and for')).toEqual([]);
  });
});
