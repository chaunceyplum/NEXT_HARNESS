/**
 * Authentication for every page and API route (see lib/auth.ts for the
 * credential settings). Next.js 16 renamed middleware to proxy; it runs on
 * the Node.js runtime.
 *
 * On success the request continues with the x-harness-user header set to
 * the authenticated name (any client-supplied value is replaced), which
 * route handlers read with requestUser().
 */

import { NextResponse, type NextRequest } from 'next/server';
import { authConfigFromEnv, authenticate, USER_HEADER } from '@/lib/auth';

export function proxy(request: NextRequest) {
  const result = authenticate(request.headers.get('authorization'), authConfigFromEnv());

  if (!result.ok) {
    const headers: Record<string, string> = {};
    if (result.challenge) headers['WWW-Authenticate'] = 'Basic realm="harness", charset="UTF-8"';
    return NextResponse.json({ error: result.message, code: 'UNAUTHORIZED' }, { status: result.status, headers });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(USER_HEADER, result.user);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Everything except build assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
