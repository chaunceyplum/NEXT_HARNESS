import { describe, expect, it } from 'vitest';
import { systemPrompt } from './agent-core';

describe('systemPrompt Launch grounding', () => {
  it('omits the Launch object model from non-Launch runs so the cached prefix stays lean', () => {
    const prompt = systemPrompt({ toolDiscovery: true });
    expect(prompt).not.toMatch(/Launch \(Reactor\) object model/);
    expect(prompt).not.toMatch(/delegate_descriptor_id/);
  });

  it('injects the Launch object model, output contract, and validation rules in Launch mode', () => {
    const prompt = systemPrompt({ toolDiscovery: true, launchMode: true });
    // Object model: property -> library -> rules{events/conditions/actions} -> data elements -> extensions.
    expect(prompt).toMatch(/Launch \(Reactor\) object model/);
    expect(prompt).toMatch(/events \+ conditions \+ actions/);
    expect(prompt).toMatch(/delegate_descriptor_id/);
    expect(prompt).toMatch(/storage_duration/);
    // Deliverable boundary: stop at a populated library, never publish.
    expect(prompt).toMatch(/do NOT publish to an environment/);
    expect(prompt).toMatch(/reporting its id/);
    // Validation rules the generated code must satisfy.
    expect(prompt).toMatch(/extension present in the property/);
    expect(prompt).toMatch(/created in the same library/);
  });

  it('leaves the rest of the prompt identical whether or not Launch mode is on', () => {
    const lean = systemPrompt({ toolDiscovery: true, memory: true });
    const launch = systemPrompt({ toolDiscovery: true, memory: true, launchMode: true });
    // The Launch block is purely additive; removing it recovers the lean prompt.
    expect(launch).toContain(lean.slice(0, 200));
    expect(launch.length).toBeGreaterThan(lean.length);
  });
});
