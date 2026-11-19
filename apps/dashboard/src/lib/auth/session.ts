import { cookies } from 'next/headers';
import { cache } from 'react';

import { config } from '@/lib/config';

/**
 * The operator's session, as the *dashboard* sees it.
 *
 * The dashboard never verifies a password and never mints a session: it asks the
 * gateway `GET /api/v1/auth/session` with the cookie it was handed, and the
 * gateway answers 200 only when that session is genuinely live. So this function
 * is not an authentication mechanism — it is a read of one that already happened
 * in the process that owns it.
 *
 * A failed probe is reported as "no session" for every reason (missing cookie,
 * expired, revoked, gateway down). The browser is then sent to the login form,
 * which is the only place that can say anything more useful; distinguishing the
 * reasons here would only relocate that message.
 *
 * `cache()` dedupes the probe across the layout, the header, and the page within
 * a single render pass — three components asking do not make three requests.
 */

export const OPERATOR_COOKIE = 'umg_operator';

export interface OperatorIdentity {
  operator: {
    id: string;
    username: string;
    displayName?: string;
    role: string;
    enabled: boolean;
  };
  session: { id: string; expiresAt: string; idleTimeoutMs: number };
  /** Echo on state-changing requests as `X-CSRF-Token`. Derived, never stored. */
  csrfToken: string;
}

export const getOperatorSession = cache(async (): Promise<OperatorIdentity | null> => {
  const jar = await cookies();
  const token = jar.get(OPERATOR_COOKIE)?.value;
  if (token === undefined || token === '') return null;

  try {
    const response = await fetch(new URL('/api/v1/auth/session', config.gatewayOrigin), {
      headers: { accept: 'application/json', cookie: `${OPERATOR_COOKIE}=${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: 'error',
    });

    if (!response.ok) return null;

    const body = (await response.json()) as { data?: OperatorIdentity };
    return body.data ?? null;
  } catch {
    // Unreachable gateway reads as "sign in"; the form itself will then report
    // that the gateway cannot be reached, which is the honest message.
    return null;
  }
});
