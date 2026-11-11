import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkFieldPaths, extractPqlFieldPaths, validateBeforeSegmentWrite } from './segment-validation';
import { clearProfileCatalogCache, type McpCall, type ProfileCatalog } from './profile-catalog';

const TENANT_GROUP = 'https://ns.adobe.com/tenant/mixins/abc';
const PERSONAL_GROUP = 'https://ns.adobe.com/xdm/context/profile-personal-details';
const ADDRESS_TYPE = 'https://ns.adobe.com/xdm/common/address';

/** A scripted platform shaped like the live one: the union is only allOf refs. */
function platform(opts: { failGroup?: boolean } = {}): { call: McpCall; calls: string[] } {
  const calls: string[] = [];
  const call: McpCall = async (name, args) => {
    calls.push(name);
    if (name === 'adobe_get_union_schema') {
      return {
        allOf: [{ $ref: TENANT_GROUP }, { $ref: PERSONAL_GROUP }, { $ref: 'https://ns.adobe.com/xdm/context/profile' }],
        'meta:extends': ['https://ns.adobe.com/tenant/schemas/should-not-be-fetched'],
      };
    }
    if (name === 'adobe_get_field_group' && args.field_group_id === TENANT_GROUP) {
      if (opts.failGroup) throw new Error('503 Service Unavailable');
      return {
        definitions: {
          customFields: {
            properties: {
              _tenant: {
                type: 'object',
                properties: {
                  isCBMmember: { type: 'string', title: 'Is CBM member', description: 'Y/N flag' },
                  hasSEP: { type: 'string', title: 'Has SEP', description: 'Y/N flag' },
                  doNotContact: { type: 'string', title: 'Do not contact' },
                  companySize: { type: 'integer', title: 'Company Size' },
                },
              },
            },
          },
        },
      };
    }
    if (name === 'adobe_get_field_group' && args.field_group_id === PERSONAL_GROUP) {
      return {
        definitions: {
          personal: {
            properties: {
              homeAddress: { $ref: ADDRESS_TYPE },
              person: { type: 'object', properties: { birthDate: { type: 'string', 'meta:xdmType': 'date' } } },
              personalEmail: { $ref: 'https://ns.adobe.com/xdm/context/email' },
            },
          },
        },
      };
    }
    if (name === 'adobe_get_data_type' && args.data_type_id === ADDRESS_TYPE) {
      return { properties: { city: { type: 'string' }, stateProvince: { type: 'string' } } };
    }
    if (name === 'adobe_get_data_type') throw new Error('404 not found');
    throw new Error(`unexpected ${name}`);
  };
  return { call, calls };
}

describe('extractPqlFieldPaths', () => {
  it('finds dotted field paths and drops trailing method calls', () => {
    expect(
      extractPqlFieldPaths('_tenant.isCBMmember = "Y" and person.birthDate.getAge() > 30 and homeAddress.stateProvince.isNotNull()')
    ).toEqual(['_tenant.isCBMmember', 'person.birthDate', 'homeAddress.stateProvince']);
  });

  it('ignores anything inside string literals', () => {
    expect(extractPqlFieldPaths('_tenant.hasSEP = "foo.bar" and _tenant.doNotContact != \'a.b\'')).toEqual([
      '_tenant.hasSEP',
      '_tenant.doNotContact',
    ]);
  });

  it('skips paths inside array filters and under select-bound variables', () => {
    const pql = 'select X from xEvent where X.eventType = "commerce.purchases" and person.orders[storeId.code = "400"].count() > 0';
    expect(extractPqlFieldPaths(pql)).toEqual(['person.orders']);
  });

  it('does not read numbers as paths', () => {
    expect(extractPqlFieldPaths('_tenant.companySize > 50.5')).toEqual(['_tenant.companySize']);
  });
});

describe('checkFieldPaths', () => {
  const catalog: ProfileCatalog = {
    complete: true,
    groupsOpened: 1,
    error: null,
    fields: [
      { path: '_tenant', type: 'object' },
      { path: '_tenant.hasSEP', type: 'string' },
      { path: 'personalEmail', type: 'object' }, // a container whose data type was never expanded
      { path: 'segmentMembership', type: 'object' },
    ],
  };

  it('passes known fields and known containers', () => {
    expect(checkFieldPaths(['_tenant.hasSEP', '_tenant'], catalog).missing).toEqual([]);
  });

  it('does not judge paths under an unexpanded container or an allow-listed root', () => {
    const r = checkFieldPaths(['personalEmail.address', 'segmentMembership.ups.abc.status', 'identityMap.ECID'], catalog);
    expect(r.missing).toEqual([]);
    expect(r.unjudged).toHaveLength(3);
  });

  it('flags an invented field, with a same-leaf suggestion', () => {
    const r = checkFieldPaths(['_tenant.foo.hasSEP', '_tenant.isSEPCustomer'], catalog);
    expect(r.missing.map((m) => m.path)).toEqual(['_tenant.foo.hasSEP', '_tenant.isSEPCustomer']);
    expect(r.missing[0].suggestions).toEqual(['_tenant.hasSEP']);
  });

  it('matches case-insensitively', () => {
    expect(checkFieldPaths(['_TENANT.hassep'], catalog).missing).toEqual([]);
  });
});

describe('validateBeforeSegmentWrite', () => {
  beforeEach(() => clearProfileCatalogCache());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lets a segment that uses only real fields through', async () => {
    const { call } = platform();
    await expect(
      validateBeforeSegmentWrite(
        'adobe_create_segment',
        { name: 'x', pql_expression: '_tenant.isCBMmember = "Y" and homeAddress.stateProvince = "PA" and personalEmail.address.isNotNull()' },
        { call }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects a segment that names a field the sandbox does not have, before anything is created', async () => {
    const { call, calls } = platform();
    await expect(
      validateBeforeSegmentWrite('adobe_create_segment', { name: 'x', pql_expression: '_tenant.region = "Northeast" and _tenant.hasSEP = "Y"' }, { call })
    ).rejects.toThrow(/validation error.*no segment was created[\s\S]*_tenant\.region/);
    expect(calls).not.toContain('adobe_create_segment');
    // meta:extends lists schemas, not field groups: never fetched as one.
    expect(calls.filter((c) => c === 'adobe_get_field_group')).toHaveLength(2);
  });

  it('says "updated" for an update', async () => {
    const { call } = platform();
    await expect(
      validateBeforeSegmentWrite('adobe_update_segment', { segment_id: 's1', pql_expression: '_tenant.nope = "Y"' }, { call })
    ).rejects.toThrow(/no segment was updated/);
  });

  it('fails open when a field group could not be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = platform({ failGroup: true });
    await expect(
      validateBeforeSegmentWrite('adobe_create_segment', { pql_expression: '_tenant.isCBMmember = "Y"' }, { call })
    ).resolves.toBeUndefined();
  });

  it('caches a complete catalog per sandbox', async () => {
    const { call, calls } = platform();
    await validateBeforeSegmentWrite('adobe_create_segment', { pql_expression: '_tenant.hasSEP = "Y"' }, { call });
    const after = calls.length;
    await validateBeforeSegmentWrite('adobe_create_segment', { pql_expression: '_tenant.hasSEP = "N"' }, { call });
    expect(calls.length).toBe(after);
  });

  it('ignores other tools, writes without PQL, and SEGMENT_FIELD_CHECK=off', async () => {
    const { call, calls } = platform();
    await validateBeforeSegmentWrite('adobe_create_schema', { pql_expression: '_tenant.nope = 1' }, { call });
    await validateBeforeSegmentWrite('adobe_update_segment', { segment_id: 's1', name: 'renamed' }, { call });
    vi.stubEnv('SEGMENT_FIELD_CHECK', 'off');
    await validateBeforeSegmentWrite('adobe_create_segment', { pql_expression: '_tenant.nope = 1' }, { call });
    expect(calls).toEqual([]);
  });
});
