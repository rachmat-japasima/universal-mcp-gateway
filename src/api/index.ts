import { Hono } from 'hono';

import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import type { AuthorizationService } from '../auth/authorization.js';
import type { CredentialKeys } from '../auth/credential-key.js';
import type { Config } from '../config/config.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { metrics } from '../monitoring/metrics.js';
import { AgentService } from '../registry/agent-service.js';
import { BackendService } from '../registry/backend-service.js';
import type { Actor } from '../registry/backend-service.js';
import { LOCAL_OPERATOR } from '../registry/backend-service.js';
import { CredentialService } from '../registry/credential-service.js';
import { PolicyService } from '../registry/policy-service.js';
import type { OperatorService } from '../registry/operator-service.js';
import type { SessionService } from '../registry/session-service.js';
import type { ToolCatalog } from '../routing/catalog.js';
import type { ToolDiscovery } from '../routing/discovery.js';
import { apiErrorHandler, getRequestId, jsonBodyLimit } from './http.js';
import { loopbackOnly, requireJsonBody } from './middleware/guards.js';
import { operatorAuth } from './middleware/operator-auth.js';
import { agentsRoutes } from './routes/agents.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { backendsRoutes } from './routes/backends.routes.js';
import { activityRoutes, auditRoutes } from './routes/events.routes.js';
import { opsRoutes } from './routes/ops.routes.js';
import { policiesRoutes } from './routes/policies.routes.js';
import { sessionsRoutes } from './routes/sessions.routes.js';
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
  /**
   * Session management. Present whenever the gateway has a store; the session
   * routes are not mounted without one rather than mounted against nothing.
   */
  sessions?: SessionService;
  /**
   * Dashboard operator authentication. Required: without it this function is
   * never called (see `createGateway`). A gateway with a management API but no
   * operator boundary is exactly the bypass Phase 10.0 exists to remove, so
   * there is no unauthenticated mode to fall back into.
   */
  operators: OperatorService;
}

export const API_PREFIX = '/api/v1';

/**
 * Management API assembly.
 *
 * Middleware order is deliberate:
 *   1. correlation ids — assigned by the outer app for every surface, so any
 *      later log/error line is correlatable
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
  const { operators } = options;  /**
   * Audit attribution for mutations.
   *
   * The dashboard ships exactly one operator (ADR-045), so the id written to
   * audit rows is that operator's. Resolved once here rather than per request:
   * the services own their actor for the life of the process, and a second
   * operator would need per-request attribution anyway — which is a Phase 10
   * concern, not a Phase 10.0 one. With no operator configured, nothing can
   * authenticate, so the legacy `local-operator` label can only appear on rows
   * written before bootstrap.
   */
  const actor = operatorActor(store);
  const backends = new BackendService(store, actor);
  const { sessions } = options;
  // Session invalidation is part of the same transaction as the credential or
  // agent change that caused it, so a revocation can never commit without its
  // sessions being ended.
  const agents = new AgentService(store, undefined, undefined, sessions);
  const credentials = new CredentialService({ store, keys: options.credentialKeys, ...(sessions === undefined ? {} : { sessions }) });
  const policies = new PolicyService({ store });
  const toolDeps = { catalog: options.catalog, discovery: options.discovery, logger, store };

  const api = new Hono();

  api.onError(apiErrorHandler(logger));

  /**
   * Order, and why:
   *   1. operator session — default deny, before any handler or body read
   *      (correlation ids are assigned on the outer app, for every surface)
   *   2. body limit       — bound allocation before parsing
   *   3. JSON content type— refuse cross-site form posts
   *
   * The session check runs before the body is touched so an unauthenticated
   * caller cannot spend the gateway's parse budget, and so a route added later
   * is protected by registration order rather than by remembering to add a guard.
   */
  api.use('*', loopbackOnly(config));
  api.use('*', operatorAuth({ operators, config }));
  api.use('*', jsonBodyLimit(config));
  api.use('*', requireJsonBody());

  const ops = opsRoutes({
    config,
    store,
    lifecycle,
    catalog: options.catalog,
    metrics,
    ...(sessions === undefined ? {} : { sessions }),
    authentication: options.credentialKeys.issuing === undefined ? 'unavailable' : 'required',
  });

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
  api.route('/auth', authRoutes({ operators, config }));
  api.route('/backends', backendsRoutes(backends, lifecycle));
  api.route('/agents', agentsRoutes({ agents, credentials, authorization: options.authorization }));
  api.route('/policies', policiesRoutes(policies));
  if (sessions !== undefined) api.route('/sessions', sessionsRoutes({ sessions }));
  api.route('/activity', activityRoutes({ store }));
  api.route('/audit', auditRoutes({ store }));
  // Overview, monitoring, readiness, diagnostics, settings and the OpenAPI
  // document share one snapshot reader, so their numbers cannot disagree.
  api.route('/', ops);

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

/**
 * Audit attribution for management mutations.
 *
 * Resolved from the single configured operator, because the services take an
 * actor at construction and the dashboard ships one operator (ADR-045). Before
 * bootstrap there is no operator and nothing can authenticate, so the only rows
 * that can exist with the legacy label predate this phase.
 */
function operatorActor(store: Database): Actor {
  const [operator] = store.operators.list();
  return operator === undefined ? LOCAL_OPERATOR : { type: 'admin', id: operator.id };
}
