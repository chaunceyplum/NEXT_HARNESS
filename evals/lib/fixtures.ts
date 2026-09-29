/**
 * Load every *.json fixture in evals/fixtures/<dir> — the golden set an eval
 * file runs against. A fixture without its own `id` gets its filename
 * (minus .json), so every fixture is identifiable in the report.
 */

import fs from 'node:fs';
import path from 'node:path';

const FIXTURES_ROOT = path.join(import.meta.dirname, '..', 'fixtures');

export function loadFixtures<T extends { id?: string }>(dir: string): (T & { id: string })[] {
  const full = path.join(FIXTURES_ROOT, dir);
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8')) as T;
      return { ...raw, id: raw.id ?? file.replace(/\.json$/, '') };
    });
}
