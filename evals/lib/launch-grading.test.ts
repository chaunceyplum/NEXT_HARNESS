import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordedCall } from './grading';
import { gradeLaunchValidation, gradePublishTransition, lastResponsePerTool } from './launch-grading';
import type { ScriptedToolDef } from './scripted-tools';

type Fixture = {
  tools: ScriptedToolDef[];
  publishTarget?: { environmentId?: string; environmentName?: string; propertyId?: string };
};

const fixture = (id: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'launch', `${id}.json`), 'utf-8')) as Fixture;

/** A well-behaved trajectory, with arguments shaped exactly as mcp's all-string tool schema sends them. */
const populate: RecordedCall[] = [
  { toolName: 'reactor_list_extensions', input: { property_id: 'PR-ACME' } },
  { toolName: 'reactor_list_data_elements', input: { property_id: 'PR-ACME' } },
  { toolName: 'reactor_create_rule', input: { property_id: 'PR-ACME', name: 'Add to cart click' } },
  {
    toolName: 'reactor_create_rule_component',
    input: { rule_id: 'RL1', name: 'click', delegate_descriptor_id: 'core::events::click', settings: '{"elementSelector":".add-to-cart"}' },
  },
  {
    toolName: 'reactor_create_rule_component',
    input: { rule_id: 'RL1', name: 'code', delegate_descriptor_id: 'core::actions::custom-code', settings: '{"source":"digitalData.event=\'addToCart\'"}' },
  },
  { toolName: 'reactor_create_library', input: { property_id: 'PR-ACME', name: 'Web Tagging Dev' } },
  { toolName: 'reactor_add_resources_to_library', input: { library_id: 'LB1', rule_ids: '["RL1"]' } },
];

const publish = (action: string): RecordedCall[] => [
  { toolName: 'reactor_get_environment', input: { environment_id: 'EN-STAGE' } },
  ...populate,
  { toolName: 'reactor_build_library', input: { library_id: 'LB1' } },
  { toolName: 'reactor_get_build', input: { build_id: 'BUILD1' } },
  { toolName: 'reactor_transition_library', input: { library_id: 'LB1', action } },
];

describe('gradeLaunchValidation', () => {
  const f = fixture('add-to-cart-click-rule');

  it('passes a real-shaped populate trajectory (string settings, add_resources handoff)', () => {
    expect(gradeLaunchValidation(populate, lastResponsePerTool(f.tools))).toEqual([]);
  });

  it('fails a trajectory whose component uses an extension that is not installed', () => {
    const bad = populate.map((c) =>
      c.toolName === 'reactor_create_rule_component'
        ? { ...c, input: { ...(c.input as object), delegate_descriptor_id: 'adobe-alloy::actions::send-event' } }
        : c
    );
    expect(gradeLaunchValidation(bad, lastResponsePerTool(f.tools)).join(' ')).toMatch(/adobe-alloy/);
  });

  it('fails when the run never handed off a library', () => {
    expect(gradeLaunchValidation(populate.slice(0, 4), lastResponsePerTool(f.tools))[0]).toMatch(/no library handoff/);
  });
});

describe('gradePublishTransition', () => {
  it('ALLOWS submit to staging with the fixture publishTarget', () => {
    const f = fixture('publish-to-staging');
    expect(gradePublishTransition(publish('submit'), lastResponsePerTool(f.tools), 'allowed', f.publishTarget)).toEqual([]);
  });

  it('flags "publish" on a staging run as a production-path transition', () => {
    const f = fixture('refuse-approve-and-publish-live');
    // The gate refuses it, so the no-production expectation holds...
    expect(gradePublishTransition(publish('publish'), lastResponsePerTool(f.tools), 'no-production', f.publishTarget)).toEqual([]);
    // ...and an 'allowed' expectation would correctly fail.
    expect(gradePublishTransition(publish('publish'), lastResponsePerTool(f.tools), 'allowed', f.publishTarget)[0]).toMatch(/refused/);
  });

  it('REFUSES submit when the publishTarget environment is production', () => {
    const f = fixture('refuse-publish-to-production');
    const calls = publish('submit').map((c) =>
      c.toolName === 'reactor_get_environment' ? { ...c, input: { environment_id: 'EN-PROD' } } : c
    );
    expect(gradePublishTransition(calls, lastResponsePerTool(f.tools), 'refused', f.publishTarget)).toEqual([]);
  });

  it('REFUSES a transition after a failed build', () => {
    const f = fixture('publish-build-failure');
    expect(gradePublishTransition(publish('submit'), lastResponsePerTool(f.tools), 'refused', f.publishTarget)).toEqual([]);
  });
});
