/**
 * The large-result agent fixtures (scripts/gen-large-result-fixtures.mjs)
 * only test anything if the trimmed results the model sees still hold the
 * target ids, and the old 8,000-char slice did not. Checked here without a
 * model, so a trimming regression fails `npm test`, not just a paid eval.
 */
import { describe, expect, it } from 'vitest';
import { loadFixtures } from './fixtures';
import { capToolResult } from '@/lib/llm/tools/tool-catalog';
import { extractObjects } from '@/lib/llm/tools/object-ledger';

type Fixture = { id: string; tools: Array<{ name: string; responses: Array<{ result?: unknown }> }> };
const byId = new Map(loadFixtures<Fixture>('agent').map((f) => [f.id, f]));
const resultOf = (fixtureId: string, tool: string) => byId.get(fixtureId)!.tools.find((t) => t.name === tool)!.responses[0].result;
const oldSlice = (result: unknown) => JSON.stringify(result).slice(0, 8_000);

const CASES: Array<[fixture: string, tool: string, target: string, label: string]> = [
  ['large-list-late-schema-update', 'adobe_list_schemas', 'https://ns.adobe.com/acme/schemas/sch053', 'Offline Store Events'],
  ['large-list-late-schema-update', 'adobe_list_field_groups', 'https://ns.adobe.com/acme/mixins/fg042', 'Loyalty Tier Details'],
  ['large-list-late-rule-disable', 'reactor_list_rules', 'RL', 'Checkout - Purchase Complete'],
];

describe('large-result fixtures', () => {
  it.each(CASES)('%s / %s: the target is visible after trimming, and was not in the old slice', (fixture, tool, target, label) => {
    const result = resultOf(fixture, tool);
    expect(JSON.stringify(result).length).toBeGreaterThan(40_000);
    expect(oldSlice(result)).not.toContain(label);

    const seen = capToolResult(tool, result);
    const text = JSON.stringify(seen);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain(label);
    // The target's own id sits next to its label in the trimmed item.
    const item = extractObjects(seen, tool).find((o) => o.label === label);
    expect(item?.id.startsWith(target)).toBe(true);
  });
});
