import { describe, expect, it } from 'vitest';
import { authConfigFromEnv, authenticate, mayApprove, parseCredentials } from './auth';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const cfg = (env: Record<string, string>) => authConfigFromEnv({ NODE_ENV: 'production', ...env });

describe('parseCredentials', () => {
  it('parses name:secret pairs and keeps colons inside secrets', () => {
    expect(parseCredentials('alice:pw, bob:a:b ,bad,:nameless,empty:')).toEqual([
      { name: 'alice', secret: 'pw' },
      { name: 'bob', secret: 'a:b' },
    ]);
  });
});

describe('authenticate', () => {
  it('refuses everything in production when nothing is configured', () => {
    const r = authenticate(null, cfg({}));
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it('allows everything in development when nothing is configured', () => {
    expect(authenticate(null, authConfigFromEnv({ NODE_ENV: 'development' }))).toEqual({ ok: true, user: 'dev' });
  });

  it('allows everything when explicitly disabled', () => {
    expect(authenticate(null, cfg({ HARNESS_AUTH_DISABLED: 'true' }))).toEqual({ ok: true, user: 'anonymous' });
  });

  it('accepts valid Basic credentials and names the user', () => {
    const c = cfg({ HARNESS_AUTH_USERS: 'alice:pw1,bob:pw2' });
    expect(authenticate(basic('bob', 'pw2'), c)).toEqual({ ok: true, user: 'bob' });
  });

  it('rejects a wrong password, an unknown user, and no header — with a Basic challenge', () => {
    const c = cfg({ HARNESS_AUTH_USERS: 'alice:pw1' });
    for (const h of [basic('alice', 'nope'), basic('mallory', 'pw1'), null, 'Basic !!!notbase64']) {
      expect(authenticate(h, c)).toMatchObject({ ok: false, status: 401, challenge: true });
    }
  });

  it('accepts a valid bearer token and names its owner', () => {
    const c = cfg({ HARNESS_API_TOKENS: 'ci-bot:tok_abc' });
    expect(authenticate('Bearer tok_abc', c)).toEqual({ ok: true, user: 'ci-bot' });
    expect(authenticate('Bearer tok_nope', c)).toMatchObject({ ok: false, status: 401, challenge: false });
  });

  it('does not accept a bearer token as a Basic password or vice versa', () => {
    const c = cfg({ HARNESS_AUTH_USERS: 'alice:pw1', HARNESS_API_TOKENS: 'bot:pw1' });
    expect(authenticate('Bearer alice:pw1', c).ok).toBe(false);
    expect(authenticate(basic('bot', 'pw1'), c).ok).toBe(false);
  });
});

describe('mayApprove', () => {
  it('allows anyone when HARNESS_APPROVERS is unset, else only the listed users', () => {
    expect(mayApprove('bob', {})).toBe(true);
    expect(mayApprove('bob', { HARNESS_APPROVERS: 'alice, carol' })).toBe(false);
    expect(mayApprove('carol', { HARNESS_APPROVERS: 'alice, carol' })).toBe(true);
  });
});
