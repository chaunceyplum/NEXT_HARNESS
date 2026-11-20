#!/usr/bin/env node
/**
 * CI regression gate for the eval suites.
 *
 *   node scripts/check-eval-baseline.mjs <metrics-dir> [--update] [--baseline evals/baseline.json]
 *
 * Reads <metrics-dir>/<suite>.json (written by evals/lib/report.ts when
 * EVAL_METRICS_DIR is set) and compares each suite against its thresholds
 * in the baseline file. Exits 1 on any regression. A suite with no metrics
 * file (skipped: no credentials for it) is reported and not failed, unless
 * EVAL_REQUIRE_ALL=true.
 *
 * --update rewrites the success floors from these results, 5 points below
 * what was measured, so ordinary run-to-run variance doesn't trip the gate.
 * Safety ceilings are never loosened by --update.
 *
 * A floor that is still null used to be skipped silently, so a suite with
 * no floor could regress to 0% and the gate still passed. Each unset floor
 * is now reported with what was measured (a ::warning:: annotation in
 * GitHub Actions), and EVAL_REQUIRE_FLOORS=true fails the gate on one.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const update = args.includes('--update');
const baselineIdx = args.indexOf('--baseline');
const baselinePath = baselineIdx !== -1 ? args[baselineIdx + 1] : 'evals/baseline.json';
const MARGIN = 0.05;

if (!dir) {
  console.error('usage: check-eval-baseline.mjs <metrics-dir> [--update] [--baseline file]');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const failures = [];
const unsetFloors = [];
let checked = 0;
const requireFloors = process.env.EVAL_REQUIRE_FLOORS === 'true';

for (const [suite, limits] of Object.entries(baseline)) {
  if (suite.startsWith('_')) continue;
  const file = join(dir, `${suite}.json`);
  if (!existsSync(file)) {
    const msg = `${suite}: no results (suite skipped)`;
    if (process.env.EVAL_REQUIRE_ALL === 'true') failures.push(msg);
    else console.log(`  - ${msg}`);
    continue;
  }
  const { metrics } = JSON.parse(readFileSync(file, 'utf8'));
  checked++;
  const checks = [
    ['success rate', metrics.successRate, limits.minSuccessRate, 'min'],
    ['pass^k', metrics.passHatK, limits.minPassHatK, 'min'],
    ['safety violation rate', metrics.safetyViolationRate, limits.maxSafetyViolationRate, 'max'],
  ];
  for (const [name, value, limit, kind] of checks) {
    if (limit == null && kind === 'min' && value != null && !update) {
      unsetFloors.push(`${suite}: no ${name} floor set (measured ${pct(value)}) — nothing stops it regressing`);
      continue;
    }
    if (limit == null || value == null) continue;
    const ok = kind === 'min' ? value >= limit : value <= limit;
    const line = `${suite}: ${name} ${pct(value)} (${kind === 'min' ? 'floor' : 'ceiling'} ${pct(limit)})`;
    if (ok) console.log(`  ✓ ${line}`);
    else failures.push(line);
  }
  if (update) {
    const floor = (v) => (v == null ? null : Math.max(0, Math.floor((v - MARGIN) * 100) / 100));
    if ('minSuccessRate' in limits) limits.minSuccessRate = floor(metrics.successRate);
    if ('minPassHatK' in limits) limits.minPassHatK = floor(metrics.passHatK);
  }
}

if (update) {
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Updated ${baselinePath} from these results (floors ${MARGIN * 100} points below measured).`);
  process.exit(0);
}

if (unsetFloors.length) {
  console.log(`\n${unsetFloors.length} success floor(s) unset. Set them from a green run: node scripts/check-eval-baseline.mjs ${dir} --update`);
  for (const u of unsetFloors) {
    console.log(`  ⚠ ${u}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Eval floor unset::${u}`);
  }
  if (requireFloors) failures.push(...unsetFloors.map((u) => `${u} (EVAL_REQUIRE_FLOORS=true)`));
}

if (failures.length) {
  console.error('\nEval regression:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(checked ? `\nNo regressions across ${checked} suite(s).` : '\nNo suites ran; nothing to check.');
