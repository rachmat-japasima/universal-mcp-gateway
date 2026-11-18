import { randomUUID } from 'node:crypto';

import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';

import type { Config } from '../config/config.js';
import { AppError, describeErrorForLog, errorDefinition, formatZodIssues, toAppError } from '../shared/errors.js';
import type { Logger } from '../monitoring/logger.js';

/** Echoed on every response so a client can correlate. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Assigns a request id, honouring a well-formed inbound one for log correlation. */
export const requestId: MiddlewareHandler = async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const id = inbound !== undefined && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
  c.set('requestId', id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
};

export function getRequestId(c: Context): string {
  return (c.get('requestId') as string | undefined) ?? 'unknown';
}

/** Consistent success envelope: `{ data }` plus optional paging metadata. */
export function ok<T>(c: Context, data: T, extra: Record<string, unknown> = {}, status = 200): Response {
  return c.json({ data, ...extra }, status as ContentfulStatusCode);
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
export function apiErrorHandler(logger: Logger) {
  return (error: unknown, c: Context): Response => {
    if (error instanceof AppError) {
      if (error.category === 'internal') {
        logger.error({ error: describeErrorForLog(error), requestId: getRequestId(c) }, 'Management API failure');
      } else {
        logger.warn(
          { code: error.code, requestId: getRequestId(c), details: error.details },
          'Management API request rejected',
        );
      }
      return errorResponse(c, error);
    }

    const mapped = toAppError(error);
    logger.error({ error: describeErrorForLog(mapped), requestId: getRequestId(c) }, 'Unhandled management API error');
    return errorResponse(c, mapped);
  };
}
