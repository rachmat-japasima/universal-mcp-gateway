import { localhostAllowedHostnames, localhostAllowedOrigins, validateHostHeader, validateOriginHeader } from '@modelcontextprotocol/server';
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

import type { Config } from '../../config/config.js';
import { AppError } from '../../shared/errors.js';
import { errorResponse } from '../http.js';

/**
 * Management API guards.
 *
 * Why not reuse `hostHeaderValidation` from `@modelcontextprotocol/hono`?
 * That middleware answers `403` with a JSON-RPC envelope, which is correct for
 * `/mcp` and wrong for a REST client that parses `{ error: { code, message } }`.
 * The underlying validators are imported from the SDK instead, so the allowlist
 * logic is shared and only the response shape differs.
 */

/** Non-loopback binding is refused at startup; this is the second line, per request. */
export function loopbackOnly(config: Config): MiddlewareHandler<{ Bindings: HttpBindings }> {
  return async (c, next) => {
    // A request that reached a non-loopback socket cannot be local, whatever the
    // Host header says. Checked first so a spoofed Host cannot mask the binding.
    const localAddress = c.env?.incoming?.socket?.localAddress;
    if (localAddress !== undefined && !isLoopbackAddress(localAddress)) {
      return errorResponse(c, new AppError('AUTHORIZATION_ERROR', 'The management API is loopback-only.'));
    }

    // Second line: config already refuses a non-loopback HOST at startup.
    if (!isLoopbackAddress(config.host)) {
      return errorResponse(c, new AppError('CONFIGURATION_ERROR', 'The management API refuses to serve a non-loopback host.'));
    }

    const host = validateHostHeader(c.req.header('host'), localhostAllowedHostnames());
    if (!host.ok) {
      return errorResponse(c, new AppError('AUTHORIZATION_ERROR', 'The request Host is not allowed.'));
    }

    // Absent Origin passes (non-browser clients); a foreign present Origin is a
    // cross-site request from a browser and is refused.
    const origin = validateOriginHeader(c.req.header('origin'), localhostAllowedOrigins());
    if (!origin.ok) {
      return errorResponse(c, new AppError('AUTHORIZATION_ERROR', 'The request origin is not allowed.'));
    }

    await next();
  };
}

/** Accepts the loopback hostnames config permits, plus their packed IPv6 forms. */
function isLoopbackAddress(address: string): boolean {
  return (
    address === 'localhost' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)
  );
}

/**
 * Requires JSON for any request that declares a content type.
 *
 * Besides being correct HTTP, this makes a plain form post fail before it is
 * parsed: HTML forms cannot send `application/json` without a CORS preflight,
 * which this API never grants.
 *
 * Keyed on the declared content type rather than on the method or on body
 * presence: a bodyless `POST .../enable` is legitimate, and over a real socket
 * `request.body` is a non-null stream even when nothing was sent. Browsers and
 * curl always set a content type when they send a body, so a cross-site form
 * post is still refused.
 */
export function requireJsonBody(): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header('content-type');
    if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
      return errorResponse(c, new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.'));
    }

    await next();
  };
}
