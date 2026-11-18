import { Hono } from 'hono';
import { z } from 'zod';

import type { SessionTerminationReason } from '../../domain/session.js';
import { sessionTerminationReasonSchema } from '../../domain/session.js';
import type { SessionService } from '../../registry/session-service.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery, readJson } from '../http.js';
import { listSessionsQuerySchema, pageMetadata, sessionIdParamSchema } from '../schemas/queries.js';

/**
 * Session management routes.
 *
 * Local operator surface, inside the existing loopback boundary — this is not a
 * client-facing API and it introduces no new authentication model. Same division
 * as the other route modules: parse, call a service, format.
 *
 * Nothing here returns a credential, a token, or transport state. `mcpSessionId`
 * is included because an operator needs it to correlate a client report; it is a
 * routing handle that cannot authenticate anything.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

/** Reason accepted by an explicit termination. Defaulted, so a bodyless call works. */
const terminateBodySchema = z
  .object({ reason: sessionTerminationReasonSchema.default('operator_terminated') })
  .strict()
  .default({ reason: 'operator_terminated' });

export interface SessionRouteDependencies {
  sessions: SessionService;
}

export function sessionsRoutes(deps: SessionRouteDependencies): Hono {
  const { sessions } = deps;
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listSessionsQuerySchema);
    const { items, total } = sessions.list(query);

    return ok(
      c,
      items.map((session) => sessions.toPublic(session)),
      { pagination: pageMetadata(query.page, query.limit, total) },
    );
  });

  /**
   * Explicit sweep. Safe to run at any time and safe to run concurrently: each
   * statement is conditional on `status = 'active'`, and rows are retained.
   */
  routes.post('/cleanup', (c) => {
    const result = sessions.cleanup();

    return ok(c, {
      expired: result.expired,
      // Internal ids only: this endpoint never emits a protocol session id it
      // did not receive, and an operator who needs the detail can list.
      sessions: result.sessions.map((session) => ({ id: session.id, terminationReason: session.terminationReason })),
    });
  });

  routes.get('/:sessionId', (c) => {
    const { sessionId } = parseParam(sessionIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, sessions.toPublic(sessions.get(sessionId)));
  });

  /**
   * Terminates a session. Idempotent: a repeat returns the already-finished
   * record, and never reactivates it.
   */
  routes.post('/:sessionId/terminate', async (c) => {
    const { sessionId } = parseParam(sessionIdParamSchema, c.req.param(), getRequestId(c));
    // A body is optional: `curl -X POST .../terminate` is the documented call.
    const raw = await c.req.text();
    let reason: SessionTerminationReason = 'operator_terminated';

    if (raw.trim() !== '') {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError('VALIDATION_ERROR', 'The request body must be valid JSON.', {
          requestId: getRequestId(c),
        });
      }
      const parsed = terminateBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The request body is invalid.', {
          requestId: getRequestId(c),
        });
      }
      reason = parsed.data.reason;
    }

    return ok(c, sessions.toPublic(sessions.terminate(sessionId, reason)));
  });

  return routes;
}
