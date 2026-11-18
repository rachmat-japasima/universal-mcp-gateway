import { Hono } from 'hono';

import { z } from 'zod';

import { createBackendSchema, updateBackendSchema } from '../../domain/backend.js';
import { toPublicBackend, type BackendService } from '../../registry/backend-service.js';
import { AppError, formatZodIssues } from '../../shared/errors.js';
import { getRequestId, ok, parseQuery, readJson } from '../http.js';
import {
  backendIdParamSchema,
  expectedVersionSchema,
  listBackendsQuerySchema,
  pageMetadata,
} from '../schemas/queries.js';

/**
 * Backend management routes.
 *
 * Each handler does exactly three things: parse, call the service, format.
 * No SQL, no rules, and no audit writes here — those live in the repository and
 * service layers so the HTTP surface stays replaceable.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

export function backendsRoutes(service: BackendService): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    // `c.req.query()` collapses repeated keys to the last value, so a duplicated
    // parameter is a silent pick rather than an ambiguity error.
    const query = parseQuery(c, listBackendsQuerySchema);
    const page = service.list(query);

    return ok(c, page.items.map(toPublicBackend), {
      pagination: pageMetadata(query.page, query.limit, page.total),
    });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c, createBackendSchema);
    return ok(c, toPublicBackend(service.create(body)), {}, 201);
  });

  /**
   * Declared before `/:backendId` so "validate" is never parsed as an id.
   *
   * The body is deliberately unvalidated here: the service answers with per-field
   * issues in a `200` result, because "this configuration is invalid" is a
   * successful answer to a well-formed question, not a request failure.
   */
  routes.post('/validate', async (c) => {
    const body = await readJson(c, z.unknown());
    return ok(c, service.validate(body));
  });

  routes.get('/:backendId', (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toPublicBackend(service.get(backendId)));
  });

  routes.patch('/:backendId', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    const expectedVersion = parseParam(expectedVersionSchema, c.req.query('expectedVersion'), getRequestId(c));
    const body = await readJson(c, updateBackendSchema);

    return ok(c, toPublicBackend(service.update(backendId, body, expectedVersion)));
  });

  routes.delete('/:backendId', (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));

    // 200 with the tombstoned representation: the client sees exactly what was
    // removed, including the version it last observed.
    return ok(c, toPublicBackend(service.remove(backendId)));
  });

  for (const enabled of [true, false] as const) {
    routes.post(enabled ? '/:backendId/enable' : '/:backendId/disable', (c) => {
      const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
      const expectedVersion = parseParam(expectedVersionSchema, c.req.query('expectedVersion'), getRequestId(c));

      return ok(c, toPublicBackend(service.setEnabled(backendId, enabled, expectedVersion)));
    });
  }

  return routes;
}
