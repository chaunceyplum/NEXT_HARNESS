/**
 * Answer-critic calibration — run manually with `npm run eval:critic`.
 *
 * The production critic (lib/llm/answer-critic.ts) checks a run's final
 * answer against its tool results, and in CRITIC_MODE=revise it rewrites
 * answers it fails. Whether that is worth turning on depends on two rates
 * this suite reports against labelled answers:
 *
 *   - catch rate: answers labelled ungrounded that the critic fails
 *   - false-flag rate: answers labelled fine that the critic fails anyway
 *     (in revise mode, each one is a good answer rewritten for nothing)
 *
 * Fixtures are the judge-calibration set (evals/fixtures/judge-calibration)
 * that carry a `criticVerdict`: the critic's narrower question — is every
 * claim supported by the tool activity, and is the request answered or a
 * blocker stated. Safety and scope cases (an injected instruction followed,
 * a delete without confirming) have no `criticVerdict`: their answers can be
 * perfectly grounded, and catching them is the approval gate's and the eval
 * judge's job, not the critic's.
 *
 * The critic model is the one production would use for runs on EVAL_MODEL
 * (or DEFAULT_MODEL): CRITIC_MODEL, else the strongest tier on that provider.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { EvalTrialRecord } from '@/lib/types';
import { checkAnswer, criticModelKey } from '@/lib/llm/answer-critic';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
import { evalModelKey, preflight, trialsPerFixture, warnSkip } from './lib/env';

type CriticFixture = {
  id: string;
  task: string;
  toolActivity?: string;
  answer: string;
  criticVerdict?: 'pass' | 'fail';
};

const runModel = evalModelKey();
const criticKey = criticModelKey(runModel);
const source = process.env.CRITIC_MODEL ? 'CRITIC_MODEL' : `strongest tier on the provider of ${runModel}`;
const trials = trialsPerFixture();
const pre = await preflight('critic calibration eval', [{ role: 'critic', key: criticKey, source }]);
if (pre.status === 'skip') warnSkip('critic calibration eval', pre.reason);
const preflightError = pre.status === 'fail' ? pre.reason : '';

const results: EvalTrialRecord[] = [];
/** Per graded trial: the label and what the critic said. */
const verdicts: { label: 'pass' | 'fail'; critic: 'pass' | 'fail' }[] = [];
const startedAt = new Date();

afterAll(async () => {
  await report({
    suite: 'critic_calibration',
    label: 'Answer critic vs labels',
    subject: criticKey,
    startedAt,
    results,
  });
  const bad = verdicts.filter((v) => v.label === 'fail');
  const good = verdicts.filter((v) => v.label === 'pass');
  if (!bad.length && !good.length) return;
  const rate = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}% (${n}/${d})` : 'n/a');
  process.stdout.write(
    `\n  critic catch rate ${rate(bad.filter((v) => v.critic === 'fail').length, bad.length)}` +
      ` · false-flag rate ${rate(good.filter((v) => v.critic === 'fail').length, good.length)}\n` +
      '  CRITIC_MODE=revise rewrites every flagged answer, so a high false-flag rate argues for staying on flag.\n'
  );
});

describe.runIf(pre.status === 'fail')('Critic calibration eval preflight', () => {
  it('configured critic is reachable', () => {
    throw new Error(preflightError);
  });
});

describe.runIf(pre.status === 'ready')(`Critic calibration eval (k=${trials})`, () => {
  const fixtures = loadFixtures<CriticFixture>('judge-calibration').filter((f) => f.criticVerdict && f.toolActivity);

  it.each(fixtures)('$id', async (fixture) => {
    const label = fixture.criticVerdict!;
    const fixtureTrials: EvalTrialRecord[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const t0 = Date.now();
      let passed = false;
      let errored = false;
      let notes = '';
      try {
        const v = await checkAnswer(criticKey, fixture.task, fixture.toolActivity!, fixture.answer);
        const critic = v.grounded && v.answersRequest ? 'pass' : 'fail';
        verdicts.push({ label, critic });
        passed = critic === label;
        if (!passed) {
          const why = [...v.unsupportedClaims.map((c) => `unsupported: ${c}`), ...v.issues].join('; ');
          notes = `labelled ${label}, critic said ${critic}${why ? ` — ${why}` : ''}`;
        }
      } catch (err) {
        // No verdict: the critic call failed, not the calibration. Excluded from the rates.
        errored = true;
        notes = `no verdict: ${err instanceof Error ? err.message : String(err)}`;
      }
      fixtureTrials.push({ fixtureId: fixture.id, trial, passed, errored, notes, durationMs: Date.now() - t0 });
    }
    results.push(...fixtureTrials);
    const failed = fixtureTrials.filter((t) => !t.passed);
    expect.soft(failed.length, failed.map((t) => `#${t.trial}${t.errored ? ' ERROR' : ''}: ${t.notes}`).join(' | ')).toBe(0);
  });
});
