import { describe, expect, it } from 'vitest';
import { mayApprove, requestUser } from './auth';

describe('requestUser', () => {
  it('reads x-harness-user, else anonymous', () => {
    expect(requestUser(new Request('http://x', { headers: { 'x-harness-user': 'alice' } }))).toBe('alice');
    expect(requestUser(new Request('http://x'))).toBe('anonymous');
  });
});

describe('mayApprove', () => {
  it('allows anyone when HARNESS_APPROVERS is unset, else only the listed users', () => {
    expect(mayApprove('bob', {})).toBe(true);
    expect(mayApprove('bob', { HARNESS_APPROVERS: 'alice, carol' })).toBe(false);
    expect(mayApprove('carol', { HARNESS_APPROVERS: 'alice, carol' })).toBe(true);
  });
});
