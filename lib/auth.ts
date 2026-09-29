/**
 * Who may use the harness. Enforced for every page and API route by
 * proxy.ts; route handlers read the resulting identity with requestUser().
 *
 * Two credential kinds, either or both:
 *   HARNESS_AUTH_USERS="alice:s3cret,bob:hunter2"  HTTP Basic, for people
 *                                                   (the browser prompts)
 *   HARNESS_API_TOKENS="ci-bot:tok_abc,cron:tok_def" Bearer tokens, for
 *                                                   scripts ("name:token")
 *
 * With neither set, the app refuses every request in production (so a
 * deploy can't silently expose an agent holding Adobe/GitHub credentials)
 * and allows everything in development. HARNESS_AUTH_DISABLED=true opts out
 * explicitly, e.g. behind a VPN or an authenticating load balancer.
 */

import { createHash, timingSafeEqual } from 'crypto';

/** Request header proxy.ts sets to the authenticated user name. Incoming copies are stripped. */
export const USER_HEADER = 'x-harness-user';

interface Credential {
  name: string;
  secret: string;
}

/** Parse "name:secret,name2:secret2". Entries without a name or secret are ignored. */
export function parseCredentials(value: string | undefined): Credential[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => {
      const i = entry.indexOf(':');
      return i > 0 ? { name: entry.slice(0, i).trim(), secret: entry.slice(i + 1) } : undefined;
    })
    .filter((c): c is Credential => Boolean(c && c.name && c.secret));
}

/** Constant-time string comparison (hashing first so lengths don't leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type AuthResult =
  | { ok: true; user: string }
  | { ok: false; status: 401 | 503; message: string; challenge: boolean };

export interface AuthConfig {
  users: Credential[];
  tokens: Credential[];
  disabled: boolean;
  production: boolean;
}

export function authConfigFromEnv(env: Record<string, string | undefined> = process.env): AuthConfig {
  return {
    users: parseCredentials(env.HARNESS_AUTH_USERS),
    tokens: parseCredentials(env.HARNESS_API_TOKENS),
    disabled: env.HARNESS_AUTH_DISABLED?.trim().toLowerCase() === 'true',
    production: env.NODE_ENV === 'production',
  };
}

/** Decide whether a request with this Authorization header may proceed, and as whom. */
export function authenticate(authorization: string | null, config: AuthConfig): AuthResult {
  if (config.disabled) return { ok: true, user: 'anonymous' };
  if (config.users.length === 0 && config.tokens.length === 0) {
    if (!config.production) return { ok: true, user: 'dev' };
    return {
      ok: false,
      status: 503,
      challenge: false,
      message:
        'Authentication is not configured. Set HARNESS_AUTH_USERS and/or HARNESS_API_TOKENS, ' +
        'or HARNESS_AUTH_DISABLED=true if something in front of this app already authenticates requests.',
    };
  }

  const [scheme, ...rest] = (authorization ?? '').trim().split(/\s+/);
  const value = rest.join(' ');

  if (scheme?.toLowerCase() === 'bearer' && value) {
    const match = config.tokens.find((t) => safeEqual(t.secret, value));
    if (match) return { ok: true, user: match.name };
  } else if (scheme?.toLowerCase() === 'basic' && value) {
    let decoded = '';
    try {
      decoded = Buffer.from(value, 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const i = decoded.indexOf(':');
    if (i > 0) {
      const name = decoded.slice(0, i);
      const password = decoded.slice(i + 1);
      // Check every entry so timing doesn't reveal which user names exist.
      let matched: string | undefined;
      for (const u of config.users) {
        if (safeEqual(u.name, name) && safeEqual(u.secret, password)) matched = u.name;
      }
      if (matched) return { ok: true, user: matched };
    }
  }

  return { ok: false, status: 401, challenge: config.users.length > 0, message: 'Authentication required.' };
}

/** The authenticated user for a request that passed proxy.ts. */
export function requestUser(request: Request): string {
  return request.headers.get(USER_HEADER) || 'anonymous';
}

/**
 * HARNESS_APPROVERS="alice,bob" limits who may approve or deny a paused
 * tool call. Unset means any authenticated user may.
 */
export function mayApprove(user: string, env: Record<string, string | undefined> = process.env): boolean {
  const list = env.HARNESS_APPROVERS?.split(',').map((s) => s.trim()).filter(Boolean);
  return !list || list.length === 0 || list.includes(user);
}
