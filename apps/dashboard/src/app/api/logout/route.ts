import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { OPERATOR_COOKIE } from '@/lib/auth/session';
import { config } from '@/lib/config';

/**
 * Sign-out, server side.
 *
 * The gateway revokes the session row *first*, then the dashboard drops its own
 * copy of the cookie. That order matters: clearing the cookie alone would leave
 * a valid session that a copied cookie could still use, which is the difference
 * between "signed out" and "signed out here".
 *
 * The gateway's `/logout` is exempt from the session requirement precisely so
 * this works with a cookie that has already expired, so there is no failure path
 * worth reporting — the answer is always "you are signed out".
 */

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(OPERATOR_COOKIE)?.value;

  if (token !== undefined && token !== '') {
    try {
      await fetch(new URL('/api/v1/auth/logout', config.gatewayOrigin), {
        method: 'POST',
        headers: { cookie: `${OPERATOR_COOKIE}=${token}`, accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      // An unreachable gateway must not trap the operator in a signed-in UI. The
      // cookie is cleared below either way; the session will expire on its own.
    }
  }

  const response = NextResponse.json({ data: { loggedOut: true } });
  response.cookies.delete(OPERATOR_COOKIE);
  return response;
}
