import { Hono } from 'hono';

import { z } from 'zod';

import type { BackendLifecycleManager } from '../../adapters/lifecycle.js';
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
 *
 * Lifecycle calls happen *after* the service transaction commits, and the
 * reconcile step is deliberately one call rather than per-field logic: the
 * manager reads the committed row itself and decides what that means.
 */

function parseParam<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new AppError('VALIDATION_ERROR', formatZodIssues(parsed.error) ?? 'The route parameter is invalid.', {
    requestId,
  });
}

export function backendsRoutes(service: BackendService, lifecycle: BackendLifecycleManager): Hono {
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
    const created = service.create(body);

    // Never auto-connects: this only makes the runtime row truthful.
    await lifecycle.reconcile(created.id, { requestId: getRequestId(c) });
    return ok(c, toPublicBackend(created), {}, 201);
  });

  /**
   * Declared before `/:backendId` so "validate" and "runtime" are never parsed
   * as ids.
   *
   * The body is deliberately unvalidated here: the service answers with per-field
   * issues in a `200` result, because "this configuration is invalid" is a
   * successful answer to a well-formed question, not a request failure.
   */
  routes.post('/validate', async (c) => {
    const body = await readJson(c, z.unknown());
    return ok(c, service.validate(body));
  });

  /** All runtime states. Literal, so it must precede `/:backendId`. */
  routes.get('/runtime', (c) => ok(c, lifecycle.getAllRuntimeStates()));

  routes.get('/:backendId', (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, toPublicBackend(service.get(backendId)));
  });

  routes.get('/:backendId/runtime', (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, lifecycle.getRuntimeState(backendId));
  });

  routes.patch('/:backendId', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    const expectedVersion = parseParam(expectedVersionSchema, c.req.query('expectedVersion'), getRequestId(c));
    const body = await readJson(c, updateBackendSchema);

    const updated = service.update(backendId, body, expectedVersion);
    // A changed connection/timeout makes a live connection describe the wrong
    // thing; the manager compares a fingerprint and tears it down if needed.
    await lifecycle.reconcile(backendId, { requestId: getRequestId(c) });

    return ok(c, toPublicBackend(updated));
  });

  routes.delete('/:backendId', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));

    // 200 with the tombstoned representation: the client sees exactly what was
    // removed, including the version it last observed.
    const removed = service.remove(backendId);
    await lifecycle.reconcile(backendId, { requestId: getRequestId(c) });

    return ok(c, toPublicBackend(removed));
  });

  for (const enabled of [true, false] as const) {
    routes.post(enabled ? '/:backendId/enable' : '/:backendId/disable', async (c) => {
      const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
      const expectedVersion = parseParam(expectedVersionSchema, c.req.query('expectedVersion'), getRequestId(c));

      const updated = service.setEnabled(backendId, enabled, expectedVersion);
      // Enable makes the backend eligible, it does not dial; disable stops
      // everything immediately.
      await lifecycle.reconcile(backendId, { requestId: getRequestId(c) });

      return ok(c, toPublicBackend(updated));
    });
  }

  // Explicit connection management. All three are idempotent where it is safe
  // to be, and none of them can reach a backend that is disabled.
  routes.post('/:backendId/connect', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, await lifecycle.connect(backendId, { requestId: getRequestId(c) }));
  });

  routes.post('/:backendId/disconnect', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, await lifecycle.disconnect(backendId, { requestId: getRequestId(c) }));
  });

  routes.post('/:backendId/reconnect', async (c) => {
    const { backendId } = parseParam(backendIdParamSchema, c.req.param(), getRequestId(c));
    return ok(c, await lifecycle.reconnect(backendId, { requestId: getRequestId(c) }));
  });

  return routes;
}
