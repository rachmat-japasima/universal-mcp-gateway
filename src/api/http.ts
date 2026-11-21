import { randomUUID } from 'node:crypto';

import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';

import type { Config } from '../config/config.js';
import { AppError, describeErrorForLog, errorDefinition, formatZodIssues, toAppError } from '../shared/errors.js';
import type { Logger } from '../monitoring/logger.js';
import { runWithCorrelation } from '../monitoring/context.js';
import { metrics as defaultMetrics, ROUTE_CLASSES, type Metrics } from '../monitoring/metrics.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Assigned by `requestCorrelation` on every surface, not just `/api/v1`. */
    requestId?: string;
    correlationId?: string;
  }
}

/** Echoed on every response so a client can correlate a single HTTP exchange. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Groups related operations across requests. A client may supply one; it is
 * validated, never trusted for anything beyond correlation.
 */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** One shape for both ids: printable, bounded, and never used as a lookup key. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Request correlation (Phase 11).
 *
 * Mounted first on the outer app so *every* surface — management API, MCP
 * endpoint, `/health`, `/ready`, `/metrics` — gets the same two ids:
 *
 *   * an inbound well-formed id is honoured for log correlation;
 *   * anything malformed or oversized is replaced, not rejected: the ids are
 *     diagnostic handles, and failing a request over one would punish clients
 *     for a logging detail;
 *   * both are stored per-request in `AsyncLocalStorage`, so handlers, auth,
 *     routing, transports and audit writes can read them without threading a
 *     parameter through every signature, and concurrent requests can never
 *     share state;
 *   * an already-assigned value is reused, so mounting this at two layers
 *     cannot mint two different ids for one request.
 */
export const requestCorrelation: MiddlewareHandler = async (c, next) => {
  const requestId = resolveId(c, REQUEST_ID_HEADER, 'requestId');
  const correlationId = resolveId(c, CORRELATION_ID_HEADER, 'correlationId');

  c.set('requestId', requestId);
  c.set('correlationId', correlationId);
  // For handlers that answer through `c.json`/`c.text` (the management API).
  c.header(REQUEST_ID_HEADER, requestId);

  return runWithCorrelation({ requestId, correlationId }, async () => {
    await next();

    // Raw responses (the SDK's MCP/SSE legs) bypass Hono's header
    // accumulation, so the header is set on the finalized response directly.
    try {
      c.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // A committed or immutable response: the ids are still on every log line.
    }
  });
};

/** Honours an assigned value, then a well-formed inbound header, then generates. */
function resolveId(c: Context, header: string, key: 'requestId' | 'correlationId'): string {
  const assigned = c.get(key);
  if (assigned !== undefined) return assigned;

  const inbound = c.req.header(header);
  return inbound !== undefined && ID_PATTERN.test(inbound) ? inbound : randomUUID();
}

export function getRequestId(c: Context): string {
  return c.get('requestId') ?? 'unknown';
}

/** The correlation id for this request, when correlation middleware ran. */
export function getCorrelationId(c: Context): string | undefined {
  return c.get('correlationId');
}

/** Consistent success envelope: `{ data }` plus optional paging metadata. */
export function ok<T>(c: Context, data: T, extra: Record<string, unknown> = {}, status = 200): Response {
  return c.json({ data, ...extra }, status as ContentfulStatusCode);
}

/**
 * Route *class*, not route template: the label set is closed
 * (`ROUTE_CLASSES`), so an added route can never mint a new series. The
 * versioned API is one class because per-endpoint REST counts are already in
 * the activity table and the operator's access log; the aggregate is what a
 * saturation question needs.
 */
export function classifyRoute(path: string): (typeof ROUTE_CLASSES)[number] {
  if (path === '/health') return 'health';
  if (path === '/ready') return 'ready';
  if (path === '/metrics') return 'metrics';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path.startsWith('/api/v1')) return 'api';
  return 'unmatched';
}

/**
 * HTTP request metrics, mounted on the outer app after correlation.
 *
 * Counts every surface — including `/health` and `/ready`, because a probe
 * storm is exactly the saturation signal the in-flight gauge exists for.
 * Errors are counted too: the error handler runs before this middleware's
 * `next()` returns, so `c.res.status` is already the failure's status.
 */
export function httpMetrics(m: Metrics = defaultMetrics): MiddlewareHandler {
  return async (c, next) => {
    const route = classifyRoute(c.req.path);
    m.adjust('umg_http_requests_inflight', {}, 1);

    const startedAt = Date.now();
    try {
      await next();
    } finally {
      m.adjust('umg_http_requests_inflight', {}, -1);
      const durationMs = Date.now() - startedAt;
      m.increment('umg_http_requests_total', { method: c.req.method, route, status: String(c.res.status) });
      m.observe('umg_http_request_duration_ms', { route }, durationMs);
    }
  };
}

/** GETs are capped by the URL length in practice; this only guards the parse cost. */
const MAX_QUERY_STRING_LENGTH = 2048;

/** Query-string parsing shared by the route modules. */
export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const raw = c.req.url;
  const queryString = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  if (queryString.length > MAX_QUERY_STRING_LENGTH) {
    throw new AppError('VALIDATION_ERROR', 'The query string is too long.', { requestId: getRequestId(c) });
  }

  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The query is invalid.', {
      requestId: getRequestId(c),
    });
  }

  return parsed.data;
}

/**
 * Error response. Uses the shared envelope so a client branches on `code`, not
 * on HTTP status text, and never sees a stack or driver message.
 */
export function errorResponse(c: Context, error: AppError): Response {
  const withId = new AppError(error.code, error.message, {
    details: error.details,
    cause: error.cause,
    requestId: error.requestId ?? getRequestId(c),
  });

  return c.json(withId.toEnvelope(), errorDefinition(error.code).httpStatus as 400);
}

/** Reads and validates a JSON body. Invalid JSON and schema failures look the same to a client. */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('VALIDATION_ERROR', 'The request body must be valid JSON.', {
      requestId: getRequestId(c),
    });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The request body is invalid.', {
      requestId: getRequestId(c),
    });
  }

  return parsed.data;
}

/** Rejects bodies over the configured limit before any handler allocates them. */
export function jsonBodyLimit(config: Config): MiddlewareHandler {
  return bodyLimit({
    maxSize: config.requestBodyLimitBytes,
    onError: (c) => errorResponse(c, new AppError('VALIDATION_ERROR', 'The request body is too large.')),
  });
}

/**
 * Error boundary for the management API.
 *
 * Expected failures are `AppError` and map directly. Anything else is logged
 * with full detail and answered with a generic `INTERNAL_ERROR`, so a SQLite
 * message or filesystem path cannot reach the client.
 */
export function apiErrorHandler(logger: Logger, m: Metrics = defaultMetrics) {
  return (error: unknown, c: Context): Response => {
    if (error instanceof AppError) {
      if (error.category === 'internal') {
        logger.error({ error: describeErrorForLog(error), requestId: getRequestId(c) }, 'Management API failure');
        m.recordError(error.code, 'api');
      } else {
        logger.warn(
          { code: error.code, requestId: getRequestId(c), details: error.details },
          'Management API request rejected',
        );
        // Client errors are high-volume by nature (a bad query parameter is
        // not an incident), so they feed the counter but not the diagnostics
        // ring, which exists to show an operator the *recent interesting* ones.
        m.increment('umg_errors_total', { code: error.code, component: 'api' });
      }
      return errorResponse(c, error);
    }

    const mapped = toAppError(error);
    logger.error({ error: describeErrorForLog(mapped), requestId: getRequestId(c) }, 'Unhandled management API error');
    m.recordError(mapped.code, 'api');
    return errorResponse(c, mapped);
  };
}
