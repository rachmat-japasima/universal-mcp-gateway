import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Config } from '../../config/config.js';
import type { AuthenticatedOperator } from '../../registry/operator-service.js';
import type { OperatorService } from '../../registry/operator-service.js';
import { AppError } from '../../shared/errors.js';
import { errorResponse, getRequestId } from '../http.js';

/**
 * Operator session enforcement for the management API.
 *
 * The boundary lives here, in the gateway, and not in the Next.js app. The
 * gateway listens on loopback and its REST surface is reachable by any local
 * process; a guard in the browser app would be cosmetic, because `curl` does not
 * load a page. Everything below is therefore about one question asked on every
 * request: *is this request carrying a live operator session?*
 *
 * Default deny is deliberate. A newly added route is protected because it did
 * not opt out, rather than exposed because nobody remembered to opt it in. The
 * exemption list is closed and short: the two endpoints whose job is to *create*
 * or *end* a session, which by definition cannot require one.
 */

/** Cookie carrying the operator session. HttpOnly, so browser JS never sees it. */
export const OPERATOR_COOKIE = 'umg_operator';

/** Header carrying the CSRF token derived from the session. */
export const CSRF_HEADER = 'x-csrf-token';

/** Methods that cannot change state, so cannot be CSRF'd. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints that must work without a session.
 *
 * `login` creates one; `logout` must clear a cookie that may already be dead,
 * otherwise the browser would keep replaying a revoked value forever. Both are
 * writes with no read surface, so an anonymous caller gains nothing.
 */
const EXEMPT: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/v1/auth/login' },
  { method: 'POST', path: '/api/v1/auth/logout' },
];

export function isExemptFromOperatorAuth(method: string, path: string): boolean {
  return EXEMPT.some((entry) => entry.method === method && entry.path === path);
}

export interface OperatorAuthOptions {
  operators: OperatorService;
  config: Config;
}

/**
 * Cookie attributes, in one place so a read and a write cannot disagree.
 *
 * `Secure` is driven by an explicit setting, never by `X-Forwarded-Proto`: that
 * header is caller-controlled, and trusting it would let a request talk the
 * gateway into (or out of) a transport assumption. Off by default because this
 * product is served over plain HTTP on loopback, where a `Secure` cookie is
 * silently dropped by the browser and login appears to do nothing.
 */
export function operatorCookieOptions(config: Config, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.operatorCookieSecure,
    path: '/',
    maxAge: maxAgeSeconds,
  } as const;
}

/** Writes the session cookie. The only place the raw token is put on the wire. */
export function issueOperatorCookie(c: Context, config: Config, token: string, expiresAt: string): void {
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  setCookie(c, OPERATOR_COOKIE, token, operatorCookieOptions(config, remaining));
}

/**
 * Clears the cookie on every rejection path.
 *
 * A 401 that left a dead cookie in the browser would make every subsequent
 * request fail the same way with no way for the user to recover, which reads as
 * a broken dashboard rather than an expired session.
 */
export function clearOperatorCookie(c: Context, config: Config): void {
  deleteCookie(c, OPERATOR_COOKIE, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.operatorCookieSecure,
    path: '/',
  });
}

/**
 * Verifies the session on every request and enforces CSRF on writes.
 *
 * The session is resolved from the cookie alone. No operator id, header, query
 * parameter, or body field is ever accepted as identity, so there is nothing a
 * client can claim about itself that this middleware would believe.
 */
export function operatorAuth(options: OperatorAuthOptions): MiddlewareHandler {
  const { operators, config } = options;

  return async (c, next) => {
    const path = c.req.path;

    if (isExemptFromOperatorAuth(c.req.method, path)) {
      await next();
      return;
    }

    const token = getCookie(c, OPERATOR_COOKIE);
    const result = operators.authenticate(token);

    if (!result.ok) {
      // One message for every reason: missing, malformed, unknown, revoked,
      // expired, disabled. The reason is not in the response, only in the log
      // line written by the service.
      clearOperatorCookie(c, config);

      return errorResponse(
        c,
        new AppError('AUTHENTICATION_ERROR', 'An operator session is required.', {
          details: { reason: result.reason },
          requestId: getRequestId(c),
        }),
      );
    }

    const identity: AuthenticatedOperator = result.value;

    /**
     * CSRF: `SameSite=Strict` already stops a cross-site *send*, but "same site"
     * on loopback includes any other port, and a browser that sends the cookie
     * is not the same as a request the operator intended. The derived token is
     * checked for every state-changing method, including bodyless POSTs, so a
     * missing header fails rather than defaulting to allowed.
     */
    if (!SAFE_METHODS.has(c.req.method)) {
      const presented = c.req.header(CSRF_HEADER);

      if (token === undefined || presented === undefined || !operators.csrfMatches(token, presented)) {
        return errorResponse(
          c,
          new AppError('AUTHORIZATION_ERROR', 'The CSRF token is missing or invalid.', {
            requestId: getRequestId(c),
          }),
        );
      }
    }

    c.set('operator', identity);
    await next();
  };
}

/** Reads the authenticated operator. Only valid after `operatorAuth` ran. */
export function currentOperator(c: Context): AuthenticatedOperator {
  const identity = c.get('operator') as AuthenticatedOperator | undefined;
  if (identity === undefined) {
    // Unreachable behind the middleware; throwing rather than returning a
    // placeholder keeps a wiring bug from becoming an anonymous request.
    throw new AppError('AUTHENTICATION_ERROR', 'An operator session is required.');
  }
  return identity;
}
