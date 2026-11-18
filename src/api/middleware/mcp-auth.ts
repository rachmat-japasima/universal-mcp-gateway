import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Context, MiddlewareHandler } from 'hono';

import type { AuthenticatedIdentity, AuthService } from '../../auth/auth-service.js';
import { isAuthenticated } from '../../auth/auth-service.js';
import type { Logger } from '../../monitoring/logger.js';
import { getRequestId } from '../http.js';

/**
 * MCP authentication boundary.
 *
 * Runs before the SDK handler and is the *only* place an MCP identity is
 * established. The SDK is passed the result as `authInfo`, which it treats as
 * strictly pass-through: it performs no verification of its own, so a request
 * that reaches the handler without having come through this middleware has no
 * identity to act on.
 *
 * The failure answer is uniform and deliberately uninformative: one status, one
 * message, one challenge. A caller cannot tell a nonexistent agent from a revoked
 * credential from an expired one, and the response carries no gateway detail.
 */

declare module 'hono' {
  interface ContextVariableMap {
    mcpIdentity?: AuthenticatedIdentity;
  }
}

/** Subject claim used whenever a scope/claim is needed but the entity is not. */
const AUTHENTICATION_REALM = 'Universal MCP Gateway';

export interface McpAuthOptions {
  auth: AuthService;
  logger: Logger;
}

/**
 * Rejects with a single 401 shape.
 *
 * `WWW-Authenticate` is sent because RFC 9110 requires a challenge on 401; it
 * names the scheme and nothing else — no realm detail, no error code, no hint
 * about which credential was wrong.
 */
function unauthorized(c: Context): Response {
  c.header('WWW-Authenticate', `Bearer realm="${AUTHENTICATION_REALM}"`);
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    },
    401,
  );
}

export function mcpAuthenticate(options: McpAuthOptions): MiddlewareHandler {
  const { auth } = options;

  return async (c, next) => {
    const result = auth.authenticate(c.req.header('authorization'), { requestId: getRequestId(c) });

    if (!isAuthenticated(result)) {
      return unauthorized(c);
    }

    c.set('mcpIdentity', result);
    await next();
  };
}

/**
 * Translates an authenticated identity into the SDK's `AuthInfo`.
 *
 * `token` is required by the type. A stable, non-secret fingerprint is used
 * instead of the bearer token: nothing downstream needs the token, and putting
 * it into an SDK object risks it being serialized into an error or log line.
 * The agent id is the identity that matters, and it is also carried in `extra`
 * so a handler does not have to parse `clientId`.
 */
export function toAuthInfo(identity: AuthenticatedIdentity): AuthInfo {
  return {
    token: `agent:${identity.agent.id}`,
    clientId: identity.agent.id,
    scopes: [],
    extra: {
      agentId: identity.agent.id,
      credentialId: identity.credential.id,
    },
  };
}
