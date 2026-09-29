#!/usr/bin/env node
/**
 * Turn a real (usually failed) production run into a draft agent eval
 * fixture, the guide's "every failure that reaches a user becomes an eval
 * case" (§5.5).
 *
 *   node scripts/run-to-fixture.mjs <run.json | https://host/api/runs/<id>> [--out dir]
 *
 * A URL is fetched with HARNESS_API_TOKEN as a bearer token (or
 * HARNESS_BASIC_AUTH="user:password"). The draft goes to
 * evals/fixtures/agent-drafts/<run-id>.json, which no suite loads. Finish it
 * by hand (write `expected`, trim the tool responses to what matters, strip
 * anything sensitive) and move it into evals/fixtures/agent/ (or
 * agent-heldout/).
 *
 * Tool responses are replayed in the order the run saw them, so the draft
 * reproduces the same situation for the model under test. Calls made through
 * call_tool are recorded under the tool they proxied.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 ? args[outIdx + 1] : 'evals/fixtures/agent-drafts';

if (!source) {
  console.error('usage: run-to-fixture.mjs <run.json | https://host/api/runs/<id>> [--out dir]');
  process.exit(2);
}

async function loadRun(src) {
  if (!/^https?:\/\//.test(src)) return JSON.parse(readFileSync(src, 'utf8'));
  const headers = {};
  if (process.env.HARNESS_API_TOKEN) headers.Authorization = `Bearer ${process.env.HARNESS_API_TOKEN}`;
  else if (process.env.HARNESS_BASIC_AUTH) headers.Authorization = `Basic ${Buffer.from(process.env.HARNESS_BASIC_AUTH).toString('base64')}`;
  const res = await fetch(src, { headers });
  if (!res.ok) throw new Error(`GET ${src}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** The tool a call actually targeted (call_tool unwrapped). */
function effectiveName(name, input) {
  if (name === 'call_tool' && input && typeof input.tool_name === 'string') return input.tool_name;
  return name;
}

function runToFixture(run) {
  const steps = run.result?.steps ?? [];
  const tools = new Map();
  const called = [];
  for (const step of steps) {
    step.toolCalls.forEach((call, i) => {
      const name = effectiveName(call.toolName, call.input);
      called.push(name);
      const res = step.toolResults[i];
      const entry = tools.get(name) ?? { name, responses: [] };
      if (res) entry.responses.push(res.error ? { error: res.error } : { result: res.output ?? null });
      tools.set(name, entry);
    });
  }
  return {
    id: `from-run-${run.id}`,
    note: `DRAFT from production run ${run.id} (${run.createdAt}). TODO: say what went wrong and what correct behaviour is, then fill in "expected". Descriptions are filled from the live MCP catalog when a tool has none here.`,
    category: 'TODO: scope | recovery | safety',
    request: run.request?.description ?? run.description,
    tools: [...tools.values()].map((t) => (t.responses.length ? t : { name: t.name })),
    expected: {
      finishReasons: ['stop'],
      criteria: ['TODO: what a correct final answer must say or must not say.'],
    },
    _observed: {
      model: run.model,
      status: run.status,
      finishReason: run.result?.finishReason,
      stopReason: run.result?.stopReason,
      toolSequence: called,
      finalText: run.result?.finalText ?? run.error,
    },
  };
}

const run = await loadRun(source);
const fixture = runToFixture(run);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${run.id}.json`);
writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote ${file} (${fixture.tools.length} tool(s), ${fixture._observed.toolSequence.length} call(s)). Finish the TODOs, then move it into evals/fixtures/agent/.`);
