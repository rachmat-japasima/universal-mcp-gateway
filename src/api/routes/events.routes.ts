import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '../../infrastructure/database/index.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery } from '../http.js';
import { activityEventIdParamSchema, listActivityQuerySchema, listAuditQuerySchema, pageMetadata } from '../schemas/queries.js';

/**
 * Activity and audit read APIs.
 *
 * Two tables, two audiences, one shape of endpoint:
 *
 *   * `/activity` — operational history ("what did the gateway do?"). High
 *     volume, short retention, no security decisions.
 *   * `/audit` — administrative history ("who changed what?"). It is the
 *     security record, so it is append-only and the *list* deliberately omits
 *     free-form metadata; the detail endpoint is the only place metadata is
 *     rendered, because reading one record is an explicit operator act.
 *
 * Neither table has a write path here. Audit immutability is a property of the
 * repository interface (no update, no delete), not of a permission check, so no
 * future route can gain one by accident.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

export interface EventRouteDependencies {
  store: Database;
}

export function activityRoutes(deps: EventRouteDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listActivityQuerySchema);
    const { items, total } = deps.store.activity.query(query);

    return ok(c, items, { pagination: pageMetadata(query.page, query.limit, total) });
  });

  routes.get('/:eventId', (c) => {
    const { eventId } = parseParam(activityEventIdParamSchema, c.req.param(), getRequestId(c));

    const event = deps.store.activity.findById(eventId);
    if (event === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested activity event does not exist.', {
        details: { eventId },
      });
    }

    return ok(c, event);
  });

  return routes;
}

export function auditRoutes(deps: EventRouteDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const query = parseQuery(c, listAuditQuerySchema);
    const { items, total } = deps.store.audit.query(query);

    return ok(c, items, { pagination: pageMetadata(query.page, query.limit, total) });
  });

  routes.get('/:eventId', (c) => {
    const { eventId } = parseParam(activityEventIdParamSchema, c.req.param(), getRequestId(c));

    const event = deps.store.audit.findById(eventId);
    if (event === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested audit event does not exist.', {
        details: { eventId },
      });
    }

    return ok(c, event);
  });

  return routes;
}
