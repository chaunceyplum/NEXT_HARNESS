import { describe, expect, it, vi } from 'vitest';

const statements: string[] = [];

vi.mock('./mcp-sql', async (orig) => ({
  ...(await orig<typeof import('./mcp-sql')>()),
  execSql: async (sql: string) => {
    statements.push(sql);
    if (!sql.includes('jsonb_array_elements')) return { rows: [] };
    return {
      rows: [
        {
          run_id: 'r1',
          created_at: '2026-11-01T10:00:00Z',
          description: 'create the gold segment',
          status: 'completed',
          entry: { ref: { kind: 'adobe:segment', id: 'seg-1' }, change: 'created', tool: 'adobe_create_segment', step: 2 },
        },
      ],
    };
  },
}));

const { findObjectHistory } = await import('./run-store');

describe('findObjectHistory', () => {
  it("reads each run's stored lineage and returns the run alongside each change", async () => {
    const history = await findObjectHistory({ id: "seg-1'; drop table x; --", kind: 'adobe:segment' });
    const sql = statements.find((s) => s.includes('jsonb_array_elements'))!;
    expect(sql).toContain("e.value->'ref'->>'id' = 'seg-1''; drop table x; --'");
    expect(sql).toContain("e.value->'ref'->>'kind' = 'adobe:segment'");
    expect(sql).toContain('ORDER BY r.created_at DESC');
    expect(history).toEqual([
      {
        ref: { kind: 'adobe:segment', id: 'seg-1' },
        change: 'created',
        tool: 'adobe_create_segment',
        step: 2,
        runId: 'r1',
        runCreatedAt: '2026-11-01T10:00:00.000Z',
        runDescription: 'create the gold segment',
        runStatus: 'completed',
      },
    ]);
  });

  it('leaves the kind filter out when no kind is given, and caps the limit', async () => {
    statements.length = 0;
    await findObjectHistory({ id: 'seg-1', limit: 5000 });
    const sql = statements.find((s) => s.includes('jsonb_array_elements'))!;
    expect(sql).not.toContain("->>'kind'");
    expect(sql).toContain('LIMIT 200');
  });
});
