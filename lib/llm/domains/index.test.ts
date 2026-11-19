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
