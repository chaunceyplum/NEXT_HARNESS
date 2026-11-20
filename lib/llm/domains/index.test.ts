import { describe, expect, it } from 'vitest';
import { DOMAIN_PACKS, domainAlwaysOnTools, domainPromptBlocks, resolveDomains } from '.';
import { launchDomainContext, launchToolsContext } from './launch/context';
import { launchAlwaysOnTools } from './launch/plan';
import { segmentDomainContext, SEGMENT_ALWAYS_ON_TOOLS } from './segments/context';
import { systemPrompt } from '../runtime/agent-core';

describe('domain pack registry', () => {
  it('keeps Launch before segments (the order is part of the cached prompt)', () => {
    expect(DOMAIN_PACKS.map((p) => p.id)).toEqual(['launch', 'segments']);
  });

  it('infers each domain from the request, and an explicit flag wins', () => {
    expect(resolveDomains({ userInput: 'list the datasets' })).toEqual({ launch: false, segments: false });
    expect(resolveDomains({ userInput: 'build an audience of gold members' })).toEqual({ launch: false, segments: true });
    expect(resolveDomains({ userInput: 'tag the site', platformFilter: ['Tags (Reactor)', 'Knowledge'] })).toEqual({ launch: true, segments: false });
    expect(resolveDomains({ userInput: 'build an audience', segmentMode: false, launchMode: true })).toEqual({ launch: true, segments: false });
  });

  it('collects prompt blocks and always-on tools of active packs, in registry order', () => {
    const opts = { publishEnabled: true };
    expect(domainPromptBlocks({ launch: true, segments: true }, opts)).toEqual([
      launchDomainContext(true),
      launchToolsContext(true),
      segmentDomainContext(),
    ]);
    expect(domainPromptBlocks({}, opts)).toEqual([]);
    expect(domainAlwaysOnTools({ launch: true, segments: true }, opts)).toEqual([...launchAlwaysOnTools(true), ...SEGMENT_ALWAYS_ON_TOOLS]);
    expect(domainAlwaysOnTools({ segments: true }, opts)).toEqual([...SEGMENT_ALWAYS_ON_TOOLS]);
  });

  it('puts each active block in the system prompt, separated by a blank line', () => {
    const prompt = systemPrompt({ launchMode: true, segmentMode: true });
    expect(prompt).toContain(`\n\n${launchDomainContext(false)}\n\n${launchToolsContext(false)}\n\n${segmentDomainContext()}\n\n`);
    expect(systemPrompt({})).not.toContain(segmentDomainContext());
  });
});

describe('domain hooks', () => {
  it('exposes domain-owned local tools in registry order', async () => {
    const { DOMAIN_LOCAL_TOOLS } = await import('.');
    expect(DOMAIN_LOCAL_TOOLS.map((t) => t.definition.name)).toEqual(['aep_find_profile_fields']);
  });

  it('keeps aep_find_profile_fields first in the local tool catalog', async () => {
    const { LOCAL_TOOL_DEFINITIONS } = await import('../tools/local-tools');
    expect(LOCAL_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(['aep_find_profile_fields', 'github_read_file', 'github_list_directory']);
  });

  it('runs no pre-call check for a tool no domain cares about', async () => {
    const { checkDomainToolCall } = await import('.');
    await expect(checkDomainToolCall('adobe_list_datasets', {})).resolves.toBeUndefined();
  });

  it('starts no session when no pack with a session is active', async () => {
    const { startDomainSessions } = await import('.');
    const input = { userInput: 'build an audience', live: false, publishEnabled: false, dryRun: false, shadow: false };
    expect(await startDomainSessions({ segments: true }, input)).toEqual({});
    expect(await startDomainSessions({ launch: true }, input)).toHaveProperty('seedPlan');
  });
});
