import { Hono } from 'hono';

import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import type { AuthorizationService } from '../auth/authorization.js';
import type { CredentialKeys } from '../auth/credential-key.js';
import type { Config } from '../config/config.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AgentService } from '../registry/agent-service.js';
import { BackendService } from '../registry/backend-service.js';
import { CredentialService } from '../registry/credential-service.js';
import { PolicyService } from '../registry/policy-service.js';
import type { ToolCatalog } from '../routing/catalog.js';
import type { ToolDiscovery } from '../routing/discovery.js';
import { apiErrorHandler, getRequestId, jsonBodyLimit, requestId } from './http.js';
import { loopbackOnly, requireJsonBody } from './middleware/guards.js';
import { agentsRoutes } from './routes/agents.routes.js';
import { backendsRoutes } from './routes/backends.routes.js';
import { policiesRoutes } from './routes/policies.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { backendToolsRoutes, toolsRoutes } from './routes/tools.routes.js';

export interface ManagementApiOptions {
  config: Config;
  logger: Logger;
  store: Database;
  lifecycle: BackendLifecycleManager;
  catalog: ToolCatalog;
  discovery: ToolDiscovery;
  /** Needed for the access preview and for validating credential issuance. */
  authorization: AuthorizationService;
  credentialKeys: CredentialKeys;
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
 * The services are constructed once per app, sharing the single database handle,
 * the process-wide lifecycle manager, and the credential keys. The API itself is
 * unauthenticated in Phase 6: it is loopback-only and there is no operator
 * identity yet, which is documented in `docs/SECURITY.md`.
 */
export function createManagementApi(options: ManagementApiOptions): Hono {
  const { config, logger, store, lifecycle } = options;
  const backends = new BackendService(store);
  const agents = new AgentService(store);
  const credentials = new CredentialService({ store, keys: options.credentialKeys });
  const policies = new PolicyService({ store });
  const toolDeps = { catalog: options.catalog, discovery: options.discovery, logger };

  const api = new Hono();

  api.onError(apiErrorHandler(logger));

  api.use('*', requestId);
  api.use('*', loopbackOnly(config));
  api.use('*', jsonBodyLimit(config));
  api.use('*', requireJsonBody());

  api.route(
    '/system',
    systemRoutes({
      service: backends,
      environment: config.environment,
      mcpEndpoint: config.mcpEndpoint,
      healthEndpoint: config.healthEndpoint,
      authentication: options.credentialKeys.issuing === undefined ? 'unavailable' : 'required',
    }),
  );
  api.route('/backends', backendsRoutes(backends, lifecycle));
  api.route('/agents', agentsRoutes({ agents, credentials, authorization: options.authorization }));
  api.route('/policies', policiesRoutes(policies));
  // `/tools` is a sibling of `/backends`, so the nested router is mounted on a
  // parameterised path instead of being folded into `backendsRoutes`: that keeps
  // the literal-before-parameter rule scoped to one file each.
  api.route('/backends/:backendId/tools', backendToolsRoutes(toolDeps));
  api.route('/tools', toolsRoutes(toolDeps));

  // A catch-all rather than `notFound()`: `route()` copies routes into the parent
  // app but not its not-found handler, so the sub-app's handler would never run.
  // Last registration wins, so this only sees genuinely unmatched paths.
  api.all('*', (c) =>
    c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'No such API endpoint.', requestId: getRequestId(c) } }, 404),
  );

  // Mounted under the version prefix by the caller.
  return api;
}
