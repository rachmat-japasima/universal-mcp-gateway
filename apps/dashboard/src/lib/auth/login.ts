import { config } from '@/lib/config';

/**
 * The dashboard's half of sign-in.
 *
 * The split is the point: the browser posts here, this module posts to the
 * gateway, and the gateway is the only place a password is verified or a session
 * minted. The dashboard's job is to carry the resulting `Set-Cookie` back on its
 * own origin, because a cookie set by `127.0.0.1:8787` belongs to that port and
 * would never be sent to `localhost:3000`.
 */

/** What the form may show. A reason from the gateway is never rendered raw. */
export interface LoginFailure {
  message: string;
  /** Short machine-ish tag, for tests and logs. Not shown to the operator. */
  reason: string;
}

export type LoginOutcome =
  | { ok: true; cookie: string; setCookie: string }
  | { ok: false; failure: LoginFailure };

/**
 * Only same-dashboard destinations are honoured.
 *
 * Without this the `next` parameter would be an open redirect: `/login?next=`
 * is attacker-supplied, and a dashboard that bounced to any host afterwards
 * would be handing out trustworthy-looking links to somewhere else.
 *
 * Resolution happens through `URL` rather than by string prefix, because a
 * prefix test accepts `/dashboard/../../etc` (which the browser resolves out of
 * the dashboard) and `/dashboardevil`. Parsing normalizes traversal and makes
 * the origin check meaningful; the origin can only change through an absolute or
 * protocol-relative candidate, both rejected below.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (candidate === null || candidate === undefined) return '/dashboard';
  // `//host` and `/\host` are read as protocol-relative by some browsers, and
  // `URL` would silently accept the first as a host.
  if (candidate.startsWith('//') || candidate.includes('\\')) return '/dashboard';

  const base = 'http://dashboard.invalid';
  let url: URL;
  try {
    url = new URL(candidate, base);
  } catch {
    return '/dashboard';
  }

  if (url.origin !== base) return '/dashboard';
  // `/dashboard` itself, or a path beneath it — never `/dashboardevil`.
  if (url.pathname !== '/dashboard' && !url.pathname.startsWith('/dashboard/')) return '/dashboard';

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Forwards credentials to the gateway, which owns verification.
 *
 * The error message is always the gateway's own: it is written for an operator
 * and is uniform across unknown user, wrong password, disabled and locked. This
 * function adds no detail, because any detail it added would be a new oracle.
 */
export async function loginWithGateway(input: {
  username: string;
  password: string;
  cookie?: string;
}): Promise<LoginOutcome> {
  let response: Response;
  try {
    response = await fetch(new URL('/api/v1/auth/login', config.gatewayOrigin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
      },
      body: JSON.stringify({ username: input.username, password: input.password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: 'error',
    });
  } catch {
    return {
      ok: false,
      failure: { message: 'Cannot reach the gateway. Check that it is running, then retry.', reason: 'unreachable' },
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    | { error?: { message?: string } }
    | undefined;

  if (!response.ok) {
    return {
      ok: false,
      failure: {
        message: body?.error?.message ?? 'The gateway rejected the sign-in request.',
        reason: response.status === 401 ? 'invalid_credentials' : `http_${response.status}`,
      },
    };
  }

  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) {
    // A success without a cookie is a broken gateway, not a signed-in operator.
    return {
      ok: false,
      failure: { message: 'The gateway did not return a session. Try signing in again.', reason: 'no_cookie' },
    };
  }

  return { ok: true, cookie: setCookie.split(';')[0]!, setCookie };
}

/**
 * Re-issues the gateway's cookie on the dashboard origin.
 *
 * Only the name/value pair is copied from the gateway's header; the attributes
 * are restated here so the cookie belongs to this host. `HttpOnly` and
 * `SameSite=Strict` are kept because preserving the protections is the whole
 * point of re-issuing. `Max-Age` is forwarded from the gateway rather than
 * re-invented, so the browser-side lifetime cannot drift from the session's.
 *
 * `Secure` is deliberately not set: this product is served over plain HTTP on
 * loopback, where the browser would silently drop it and sign-in would appear to
 * do nothing.
 */
export function dashboardCookie(cookiePair: string, maxAgeSeconds: number | undefined): {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
  maxAge?: number;
} {
  const separator = cookiePair.indexOf('=');

  return {
    name: cookiePair.slice(0, separator),
    value: cookiePair.slice(separator + 1),
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  };
}

/** Reads `Max-Age` from a `Set-Cookie` header. Absent means a session cookie. */
export function maxAgeOf(setCookie: string): number | undefined {
  const match = /;\s*max-age=(\d+)/i.exec(setCookie);
  return match === null ? undefined : Number(match[1]);
}
