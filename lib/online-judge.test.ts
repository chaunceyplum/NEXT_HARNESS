import { afterEach, describe, expect, it, vi } from 'vitest';

const judge = vi.fn();
const saved: unknown[] = [];

vi.mock('@/evals/lib/judge', async (orig) => ({ ...(await orig<typeof import('@/evals/lib/judge')>()), judge }));
vi.mock('@/evals/lib/env', () => ({ judgeModelKey: () => 'judge:strong' }));
vi.mock('./run-quality', () => ({ saveJudgment: async (id: string, j: unknown) => saved.push({ id, ...(j as object) }) }));

const { judgeRun, onlineSampleRate, shouldJudgeRun } = await import('./online-judge');

afterEach(() => {
  delete process.env.ONLINE_JUDGE_SAMPLE_RATE;
  delete process.env.ONLINE_JUDGE_MODEL;
  judge.mockReset();
  saved.length = 0;
});

describe('sampling', () => {
  it('defaults to 10%, clamps, and can be disabled', () => {
    expect(onlineSampleRate()).toBe(0.1);
    process.env.ONLINE_JUDGE_SAMPLE_RATE = '5';
    expect(onlineSampleRate()).toBe(1);
    process.env.ONLINE_JUDGE_SAMPLE_RATE = '0';
    expect(shouldJudgeRun(() => 0)).toBe(false);
    process.env.ONLINE_JUDGE_SAMPLE_RATE = '0.5';
    expect(shouldJudgeRun(() => 0.49)).toBe(true);
    expect(shouldJudgeRun(() => 0.5)).toBe(false);
  });
});

describe('judgeRun', () => {
  const input = {
    runId: 'r1',
    task: 'list segments',
    answer: 'There are 2 segments.',
    steps: [{ stepNumber: 0, text: '', toolCalls: [{ toolName: 'adobe_list_segments', input: {} }], toolResults: [{ toolName: 'adobe_list_segments', output: { items: [1, 2] } }] }],
  };

  it('grades with the eval rubric (base criteria + completeness) and stores the result', async () => {
    judge.mockResolvedValue({ pass: true, scores: [{ criterion: 1, score: 5, evidence: 'x' }], verdict: 'pass', reasoning: 'ok', judgedBy: 'judge:strong' });
    await expect(judgeRun(input)).resolves.toBe(true);
    const [model, judgeInput] = judge.mock.calls[0];
    expect(model).toBe('judge:strong');
    expect(judgeInput.criteria[0]).toMatch(/^Completeness/);
    expect(judgeInput.criteria.some((c: string) => c.startsWith('Safety'))).toBe(true);
    expect(judgeInput.toolActivity).toContain('RESULT adobe_list_segments');
    expect(saved).toEqual([expect.objectContaining({ id: 'r1', pass: true, judgedBy: 'judge:strong' })]);
  });

  it('never throws when the judge fails', async () => {
    judge.mockRejectedValue(new Error('refused'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(judgeRun(input)).resolves.toBe(false);
    expect(saved).toEqual([]);
    spy.mockRestore();
  });
});
