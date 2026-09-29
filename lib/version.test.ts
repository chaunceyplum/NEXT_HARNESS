import { afterEach, describe, expect, it } from 'vitest';
import { shortHash, promptVersion, toolsetVersion, appVersion } from './version';
import { systemPrompt } from './llm/agent-core';

describe('shortHash', () => {
  it('is a stable 12-char hex digest', () => {
    const h = shortHash('hello');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(shortHash('hello')).toBe(h);
  });

  it('changes when the input changes', () => {
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});

describe('promptVersion', () => {
  it('hashes the exact system prompt text', () => {
    expect(promptVersion({ toolDiscovery: false })).toBe(shortHash(systemPrompt({ toolDiscovery: false })));
  });

  it('differs between the tool-discovery and eval prompt variants', () => {
    // The live run includes the find_tools/call_tool rule; the eval path does not.
    expect(promptVersion({ toolDiscovery: true })).not.toBe(promptVersion({ toolDiscovery: false }));
  });

  it('defaults to the no-discovery variant (matches the eval)', () => {
    expect(promptVersion()).toBe(promptVersion({ toolDiscovery: false }));
  });
});

describe('toolsetVersion', () => {
  it('is order-independent', () => {
    const a = toolsetVersion([
      { name: 'x', description: 'reads x' },
      { name: 'y', description: 'writes y' },
    ]);
    const b = toolsetVersion([
      { name: 'y', description: 'writes y' },
      { name: 'x', description: 'reads x' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a description changes', () => {
    const before = toolsetVersion([{ name: 'x', description: 'reads x' }]);
    const after = toolsetVersion([{ name: 'x', description: 'reads x (v2)' }]);
    expect(before).not.toBe(after);
  });

  it('changes when a tool is added', () => {
    const one = toolsetVersion([{ name: 'x', description: 'd' }]);
    const two = toolsetVersion([
      { name: 'x', description: 'd' },
      { name: 'z', description: 'd2' },
    ]);
    expect(one).not.toBe(two);
  });

  it('treats a missing description as empty', () => {
    expect(toolsetVersion([{ name: 'x' }])).toBe(toolsetVersion([{ name: 'x', description: '' }]));
  });
});

describe('appVersion', () => {
  const saved = { git: process.env.GIT_SHA, app: process.env.APP_VERSION, pkg: process.env.npm_package_version };
  afterEach(() => {
    process.env.GIT_SHA = saved.git;
    process.env.APP_VERSION = saved.app;
    process.env.npm_package_version = saved.pkg;
  });

  it('prefers GIT_SHA', () => {
    process.env.GIT_SHA = 'abc123';
    process.env.APP_VERSION = 'v9';
    expect(appVersion()).toBe('abc123');
  });

  it('falls back to APP_VERSION then package version', () => {
    delete process.env.GIT_SHA;
    process.env.APP_VERSION = 'v9';
    expect(appVersion()).toBe('v9');
    delete process.env.APP_VERSION;
    process.env.npm_package_version = '1.2.3';
    expect(appVersion()).toBe('1.2.3');
  });

  it("is 'dev' when nothing is set", () => {
    delete process.env.GIT_SHA;
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    expect(appVersion()).toBe('dev');
  });
});
