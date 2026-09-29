import { beforeEach, describe, expect, it, vi } from 'vitest';

const statements: string[] = [];
let failInserts = false;

vi.mock('./mcp-sql', async (orig) => ({
  ...(await orig<typeof import('./mcp-sql')>()),
  execSql: async (sql: string) => {
    statements.push(sql);
    if (failInserts && sql.startsWith('INSERT')) throw new Error('db down');
    return { rows: sql.startsWith('SELECT') ? [{ id: 'a', at: '2026-09-29T00:00:00Z', type: 'tool_call', actor: 'alice', run_id: 'r1', tool: 'execute_sql', level: 'write', outcome: 'ok' }] : [] };
  },
}));

const { auditInput, listAudit, recordAudit } = await import('./audit-log');

beforeEach(() => {
  statements.length = 0;
  failInserts = false;
});

describe('recordAudit', () => {
  it('writes every event in one insert, redacting credentials from inputs and errors', async () => {
    const token = 'ghp_' + 'a'.repeat(36);
    await recordAudit([
      { type: 'tool_call', runId: 'r1', actor: 'alice', tool: 'msb_github_commit_code', level: 'write', input: { token }, outcome: 'ok' },
      { type: 'approval', runId: 'r1', actor: 'bob', tool: 'adobe_delete_segment', outcome: 'denied', error: `leaked ${token}` },
    ]);
    const inserts = statements.filter((s) => s.startsWith('INSERT'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("'alice'");
    expect(inserts[0]).toContain("'bob'");
    expect(inserts[0]).not.toContain(token);
    expect(inserts[0]).toContain('[REDACTED:github-token]');
  });

  it('never throws when the database is unavailable', async () => {
    failInserts = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordAudit([{ type: 'run_start', actor: 'alice' }])).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('writes nothing for an empty batch', async () => {
    await recordAudit([]);
    expect(statements).toEqual([]);
  });
});

describe('auditInput', () => {
  it('truncates large inputs', () => {
    const out = auditInput({ sql: 'x'.repeat(10_000) }) as { _truncated: boolean; preview: string };
    expect(out._truncated).toBe(true);
    expect(out.preview.length).toBe(4_000);
  });
});

describe('listAudit', () => {
  it('filters with escaped values and maps rows', async () => {
    const rows = await listAudit({ runId: "r1' OR '1'='1", actor: 'alice', limit: 10_000 });
    const select = statements.find((s) => s.startsWith('SELECT'))!;
    expect(select).toContain("run_id = 'r1'' OR ''1''=''1'");
    expect(select).toContain('LIMIT 500');
    expect(rows[0]).toMatchObject({ id: 'a', runId: 'r1', actor: 'alice', tool: 'execute_sql', outcome: 'ok' });
  });
});
