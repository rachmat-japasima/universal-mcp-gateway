import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getOperatorSession, OPERATOR_COOKIE, type OperatorIdentity } from '@/lib/auth/session';

/**
 * The operator cookie, as a `cookie` header for an outbound gateway call.
 *
 * The gateway requires an operator session for every `/api/v1` route (Phase
 * 10.0), so a server-side read has to carry the browser's cookie forward — there
 * is no other identity the dashboard could legitimately offer.
 *
 * Returns `undefined` outside a request scope (tests, scripts) and when no
 * cookie is present, which lets the API client stay a plain function.
 */
export async function operatorCookieHeader(): Promise<string | undefined> {
  try {
    const token = (await cookies()).get(OPERATOR_COOKIE)?.value;
    return token === undefined || token === '' ? undefined : `${OPERATOR_COOKIE}=${token}`;
  } catch {
    return undefined;
  }
}

/**
 * The operator cookie and CSRF token, for a write this dashboard makes itself.
 *
 * Both come from one session probe, so a write can never pair a cookie with a
 * token derived from a different session. `undefined` means "no live session";
 * the caller turns that into a sign-in message rather than letting the gateway
 * answer `403`, which would look like a permissions bug.
 *
 * Cached per request by `getOperatorSession()`, so the layout's guard probe and
 * a page's write share one round trip rather than making two.
 */
export async function operatorCredentials(): Promise<{ cookie?: string; csrfToken?: string }> {
  const session = await getOperatorSession();
  const cookie = await operatorCookieHeader();

  if (session === null || cookie === undefined) return {};
  return { cookie, csrfToken: session.csrfToken };
}

/**
 * Redirects to the login form unless the gateway confirms a live session.
 *
 * The *probe* decides, not the cookie's presence: a revoked or expired cookie is
 * indistinguishable from no cookie here, which is precisely what a
 * cookie-existence check would get wrong. This still is not the security
 * boundary — the gateway enforces that on every request — it only decides where
 * a browser with no business in the dashboard is sent, and where it returns to.
 */
export async function requireOperator(nextPath: string): Promise<OperatorIdentity> {
  const session = await getOperatorSession();
  if (session === null) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return session;
}
