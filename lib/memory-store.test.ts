import { beforeEach, describe, expect, it, vi } from 'vitest';

const statements: string[] = [];
let count = 0;
let existing = false;

vi.mock('./mcp-sql', async (orig) => ({
  ...(await orig<typeof import('./mcp-sql')>()),
  execSql: async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith('SELECT count')) return { rows: [{ n: count }] };
    if (sql.startsWith('SELECT 1')) return { rows: existing ? [{ '?column?': 1 }] : [] };
    if (sql.startsWith('INSERT')) return { rows: [{ key: 'aep.prod_sandbox', value: 'prod', updated_by: 'alice', updated_at: '2026-09-29T00:00:00Z' }] };
    return { rows: [] };
  },
}));

const { memoryPreamble, saveFact, validateFact, MAX_FACTS } = await import('./memory-store');

beforeEach(() => {
  statements.length = 0;
  count = 0;
  existing = false;
});

describe('validateFact', () => {
  it('accepts a short identifier under a well-formed key', () => {
    expect(validateFact('aep.prod_sandbox', 'prod')).toBeUndefined();
    expect(validateFact('launch.web-property', 'PR1234abcd')).toBeUndefined();
  });

  it('rejects bad keys, empty or long values, credentials and personal data', () => {
    expect(validateFact('Prod Sandbox', 'prod')).toMatch(/key must be/);
    expect(validateFact('x', 'prod')).toMatch(/key must be/);
    expect(validateFact('aep.sandbox', '  ')).toMatch(/empty/);
    expect(validateFact('aep.notes', 'x'.repeat(301))).toMatch(/longer than/);
    expect(validateFact('github.token', 'ghp_' + 'a'.repeat(36))).toMatch(/credential/);
    expect(validateFact('support.owner', 'jane.doe@example.com')).toMatch(/personal data/);
  });
});

describe('saveFact', () => {
  it('upserts a valid fact, lowercasing the key', async () => {
    const fact = await saveFact({ key: 'AEP.prod_sandbox', value: 'prod', updatedBy: 'alice' });
    expect(fact).toMatchObject({ key: 'aep.prod_sandbox', value: 'prod', updatedBy: 'alice' });
    const insert = statements.find((s) => s.startsWith('INSERT'))!;
    expect(insert).toContain("'aep.prod_sandbox'");
    expect(insert).toContain('ON CONFLICT (key) DO UPDATE');
  });

  it('refuses without touching the database when the fact is not storable', async () => {
    await expect(saveFact({ key: 'aws.key', value: 'AKIA' + 'ABCDEFGHIJKLMNOP', updatedBy: 'agent' })).rejects.toThrow(/Not stored: .*credential/);
    expect(statements.filter((s) => s.startsWith('INSERT'))).toEqual([]);
  });

  it('refuses a new key when memory is full, but still allows updating an existing one', async () => {
    count = MAX_FACTS;
    await expect(saveFact({ key: 'aep.new', value: 'x', updatedBy: 'agent' })).rejects.toThrow(/memory is full/);
    existing = true;
    await expect(saveFact({ key: 'aep.prod_sandbox', value: 'prod2', updatedBy: 'agent' })).resolves.toBeDefined();
  });
});

describe('memoryPreamble', () => {
  it('lists facts with a staleness warning, or nothing when empty', () => {
    expect(memoryPreamble([])).toBe('');
    const text = memoryPreamble([{ key: 'aep.prod_sandbox', value: 'prod', updatedBy: 'a', updatedAt: '' }]);
    expect(text).toContain('- aep.prod_sandbox: prod');
    expect(text).toMatch(/may be out of date/);
  });
});
