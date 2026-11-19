import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { dashboardCookie, loginWithGateway, maxAgeOf, safeNextPath } from '@/lib/auth/login';
import { OPERATOR_COOKIE } from '@/lib/auth/session';
import { config } from '@/lib/config';

/**
 * Sign-in, server side.
 *
 * The browser posts here and never to the gateway: the gateway is loopback-only
 * and sends no CORS headers, so a browser `fetch` to it could not read the
 * answer. More importantly, verification must not happen in the browser — this
 * handler forwards credentials and nothing else, and it decides nothing about
 * whether they were right. The gateway's `401` is passed through, and the cookie
 * it mints is re-issued on this origin so the browser will send it here.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'The sign-in request was not valid JSON.', reason: 'invalid_body' } },
      { status: 400 },
    );
  }

  const { username, password, next } = (body ?? {}) as Record<string, unknown>;

  if (typeof username !== 'string' || typeof password !== 'string' || username === '' || password === '') {
    return NextResponse.json(
      { error: { message: 'Enter a username and password.', reason: 'missing_credentials' } },
      { status: 400 },
    );
  }

  const existing = (await cookies()).get(OPERATOR_COOKIE)?.value;
  const outcome = await loginWithGateway({
    username,
    password,
    ...(existing === undefined ? {} : { cookie: `${OPERATOR_COOKIE}=${existing}` }),
  });

  if (!outcome.ok) {
    // 401 for anything the gateway refused, so the browser does not treat a
    // failed sign-in as a network problem.
    const status = outcome.failure.reason === 'unreachable' ? 503 : 401;
    return NextResponse.json({ error: outcome.failure }, { status });
  }

  const response = NextResponse.json({
    data: { next: typeof next === 'string' ? safeNextPath(next) : '/dashboard' },
  });

  // Re-issued, not copied verbatim: the gateway's cookie carried its own port.
  const options = dashboardCookie(outcome.cookie, maxAgeOf(outcome.setCookie));
  response.cookies.set({ ...options, secure: config.gatewayOrigin.startsWith('https:') });

  return response;
}
