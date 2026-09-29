/**
 * Model-routing accuracy — `npm run eval:routing`.
 *
 * lib/llm/model-router.ts sends each "auto" request to a model tier. A
 * misroute is either wasted money (a lookup on the strong model) or a weak
 * model on a multi-step build, so this measures how often the category is
 * right on labelled requests, including ambiguous ones that should come
 * back "unclear". Rules decide the clear cases for free; the rest go to the
 * cheap-tier router model, which this suite needs credentials for.
 *
 * An "unclear" label is also satisfied by a low-confidence fallback to the
 * default model: both mean "don't guess".
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { EvalTrialRecord } from '@/lib/types';
import { routeRequest, type RouteCategory } from '@/lib/llm/model-router';
import { loadFixtures } from './lib/fixtures';
import { report } from './lib/report';
import { modelSource, preflight, warnSkip } from './lib/env';
import { getDefaultModelKey } from '@/lib/llm/model-registry';

type RoutingFixture = { id: string; request: string; expected: RouteCategory };

const subject = getDefaultModelKey();
const pre = await preflight('routing eval', [{ role: 'router (default model provider)', key: subject, source: modelSource('model') }]);
if (pre.status === 'skip') warnSkip('routing eval', pre.reason);

const results: EvalTrialRecord[] = [];
const startedAt = new Date();
afterAll(() => report({ suite: 'routing', label: 'Model routing accuracy', subject: `router for ${subject}`, startedAt, results }));

describe.runIf(pre.status === 'fail')('Routing eval preflight', () => {
  it('configured models are reachable', () => {
    throw new Error(pre.status === 'fail' ? pre.reason : '');
  });
});

describe.runIf(pre.status === 'ready')('Model routing accuracy', () => {
  it.each(loadFixtures<RoutingFixture>('routing'))('$id', async (fixture) => {
    const t0 = Date.now();
    const route = await routeRequest(fixture.request);
    const got = route.via === 'fallback' ? 'unclear' : route.category;
    const passed = got === fixture.expected;
    results.push({
      fixtureId: fixture.id,
      trial: 1,
      passed,
      category: fixture.expected,
      durationMs: Date.now() - t0,
      notes: passed ? '' : `expected ${fixture.expected}, routed ${route.category} via ${route.via} (${Math.round(route.confidence * 100)}%): ${route.reason}`,
    });
    expect(got, route.reason).toBe(fixture.expected);
  });
});
