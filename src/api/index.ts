import { Hono } from 'hono';

import type { Config } from '../config/config.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { BackendService } from '../registry/backend-service.js';
import { apiErrorHandler, getRequestId, jsonBodyLimit, requestId } from './http.js';
import { loopbackOnly, requireJsonBody } from './middleware/guards.js';
import { backendsRoutes } from './routes/backends.routes.js';
import { systemRoutes } from './routes/system.routes.js';

export interface ManagementApiOptions {
  config: Config;
  logger: Logger;
  store: Database;
}

export const API_PREFIX = '/api/v1';

/**
 * Management API assembly.
 *
 * Middleware order is deliberate:
 *   1. request id      — so every later log/error line is correlatable
 *   2. loopback guard  — reject non-local traffic before reading a body
 *   3. body limit      — bound allocation before parsing
 *   4. JSON content type — reject cross-site form posts
 *
 * The service is constructed once per app, sharing the single database handle.
 */
export function createManagementApi(options: ManagementApiOptions): Hono {
  const { config, logger, store } = options;
  const service = new BackendService(store);

  const api = new Hono();

  api.onError(apiErrorHandler(logger));

  api.use('*', requestId);
  api.use('*', loopbackOnly(config));
  api.use('*', jsonBodyLimit(config));
  api.use('*', requireJsonBody());

  api.route('/system', systemRoutes({ service, environment: config.environment, mcpEndpoint: config.mcpEndpoint, healthEndpoint: config.healthEndpoint }));
  api.route('/backends', backendsRoutes(service));

  // A catch-all rather than `notFound()`: `route()` copies routes into the parent
  // app but not its not-found handler, so the sub-app's handler would never run.
  // Last registration wins, so this only sees genuinely unmatched paths.
  api.all('*', (c) =>
    c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'No such API endpoint.', requestId: getRequestId(c) } }, 404),
  );

  // Mounted under the version prefix by the caller.
  return api;
}
