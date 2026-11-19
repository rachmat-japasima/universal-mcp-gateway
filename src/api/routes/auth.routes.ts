import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';

import type { Config } from '../../config/config.js';
import type { OperatorService } from '../../registry/operator-service.js';
import { AppError } from '../../shared/errors.js';
import { getRequestId, ok, readJson } from '../http.js';
import { clearOperatorCookie, currentOperator, issueOperatorCookie, OPERATOR_COOKIE } from '../middleware/operator-auth.js';

/**
 * Operator authentication endpoints.
 *
 * These three routes are the only part of `/api/v1` reachable without a session,
 * and only two of them are exempt (`login`, `logout`); `session` needs the
 * middleware like any other read, which is what makes it a real probe rather
 * than a claim by the client.
 *
 * The password only ever travels into `OperatorService.login`; it is not logged,
 * not echoed, and not retained. The response body is the operator's public
 * shape, which structurally has no hash field.
 */

const loginBodySchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(200),
  })
  .strict();

export interface AuthRouteDependencies {
  operators: OperatorService;
  config: Config;
}

export function authRoutes(deps: AuthRouteDependencies): Hono {
  const routes = new Hono();

  /**
   * Verifies credentials and starts a session.
   *
   * Both a bad username and a bad password answer the same body and status. The
   * `code` is `AUTHENTICATION_ERROR` for everything: a distinct
   * `RESOURCE_NOT_FOUND` for an unknown user would undo the enumeration defence
   * the service works to provide.
   */
  routes.post('/login', async (c) => {
    const body = await readJson(c, loginBodySchema);
    const requestId = getRequestId(c);

    const result = deps.operators.login(
      {
        username: body.username,
        password: body.password,
        ...userAgentOf(c),
        ...ipAddressOf(c),
      },
      getCookie(c, OPERATOR_COOKIE),
    );

    if (!result.ok) {
      // A missing operator is a setup problem, not a credential problem, and the
      // operator needs to be told to run the bootstrap command. It is safe to
      // say so only when the instance has *no* operator at all — anything more
      // specific would become an oracle.
      const message = deps.operators.isConfigured()
        ? 'The username or password is incorrect.'
        : 'No operator is configured. Run `pnpm operator:create` on the gateway host.';

      throw new AppError('AUTHENTICATION_ERROR', message, { requestId });
    }

    issueOperatorCookie(c, deps.config, result.token, result.session.expiresAt);

    return ok(c, {
      operator: result.operator,
      session: {
        id: result.session.id,
        createdAt: result.session.createdAt,
        expiresAt: result.session.expiresAt,
        lastSeenAt: result.session.lastSeenAt,
        idleTimeoutMs: deps.config.operatorSessionIdleTimeoutMs,
      },
      /**
       * Derived from the cookie value, so the browser can echo it on writes while
       * a cross-site attacker — who cannot read the HttpOnly cookie — cannot
       * compute it.
       */
      csrfToken: result.csrfToken,
    });
  });

  /**
   * Ends the current session.
   *
   * Exempt from the auth middleware so a browser holding a dead cookie can still
   * clear it. Revocation is by cookie value, and a value that does not resolve
   * is simply "already logged out" rather than an error: there is nothing to
   * authenticate and nothing to leak.
   */
  routes.post('/logout', (c) => {
    deps.operators.logout(getCookie(c, OPERATOR_COOKIE));
    clearOperatorCookie(c, deps.config);

    return ok(c, { loggedOut: true });
  });

  /** Describes the caller's own session. Behind the middleware, so it is a probe. */
  routes.get('/session', (c) => {
    const identity = currentOperator(c);

    return ok(c, {
      operator: {
        id: identity.operator.id,
        username: identity.operator.username,
        ...(identity.operator.displayName === undefined ? {} : { displayName: identity.operator.displayName }),
        role: identity.operator.role,
        enabled: identity.operator.enabled,
        ...(identity.operator.lastLoginAt === undefined ? {} : { lastLoginAt: identity.operator.lastLoginAt }),
        createdAt: identity.operator.createdAt,
        updatedAt: identity.operator.updatedAt,
      },
      session: {
        id: identity.session.id,
        createdAt: identity.session.createdAt,
        lastSeenAt: identity.session.lastSeenAt,
        expiresAt: identity.session.expiresAt,
        idleTimeoutMs: deps.config.operatorSessionIdleTimeoutMs,
      },
      csrfToken: identity.csrfToken,
    });
  });

  return routes;
}

/** Fingerprint for the audit trail only. Never trusted, never used to authorize. */
function userAgentOf(c: Parameters<typeof getRequestId>[0]): { userAgent?: string } {
  const value = c.req.header('user-agent');
  if (value === undefined || value === '') return {};
  return { userAgent: value.slice(0, 300) };
}

function ipAddressOf(c: Parameters<typeof getRequestId>[0]): { ipAddress?: string } {
  // The socket peer, not a forwarded header: a forwarded address would be
  // caller-controlled and this value is evidence, not a decision input.
  const address =
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  if (address === undefined || address === '') return {};
  return { ipAddress: address };
}
