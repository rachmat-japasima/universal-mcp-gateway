import { Hono } from 'hono';
import type { Context } from 'hono';

import type { BackendLifecycleManager } from '../../adapters/lifecycle.js';
import type { Config } from '../../config/config.js';
import type { Database } from '../../infrastructure/database/index.js';
import type { SessionService } from '../../registry/session-service.js';
import { SERVICE_INFO } from '../../shared/service.js';
import type { ToolCatalog } from '../../routing/catalog.js';
import { ok } from '../http.js';
import { buildOpenApi } from '../openapi.js';
import { databaseResponds, migrationVersion, opsSnapshot, type OpsSnapshot } from '../ops.js';

/**
 * Observability routes: overview, monitoring, readiness, diagnostics, settings,
 * and the OpenAPI document.
 *
 * Two principles, both from the phase brief:
 *
 *   * never fabricate — every number comes from `opsSnapshot()`, a repository,
 *     or the lifecycle manager. An empty registry reports zeros; a failed read
 *     reports `unavailable` so a dashboard can tell "none" from "unknown".
 *   * never leak — `/settings` and `/diagnostics` are the two most tempting
 *     places to dump `process.env`. They report effective, non-secret values
 *     only; the credential secret is not on `Config` at all, which is what makes
 *     that structurally true rather than a promise in a comment.
 */

/** Non-secret view of the effective configuration. The key list is explicit on purpose. */
function publicSettings(config: Config) {
  return {
    environment: config.environment,
    host: config.host,
    port: config.port,
    endpoints: { mcp: config.mcpEndpoint, health: config.healthEndpoint, api: '/api/v1' },
    logging: { level: config.logLevel },
    limits: {
      requestBodyLimitBytes: config.requestBodyLimitBytes,
      requestTimeoutMs: config.requestTimeoutMs,
      toolDiscoveryTimeoutMs: config.toolDiscoveryTimeoutMs,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    },
    sessions: {
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      maxLifetimeMs: config.sessionMaxLifetimeMs,
    },
    backendConnections: {
      reconnect: {
        enabled: config.reconnectEnabled,
        initialDelayMs: config.reconnectInitialDelayMs,
        maxDelayMs: config.reconnectMaxDelayMs,
        maxAttempts: config.reconnectMaxAttempts,
        jitterRatio: config.reconnectJitterRatio,
      },
      /**
       * A security-relevant boolean, not a secret: it widens the SSRF surface
       * and an operator should be able to see that it is on.
       */
      allowPrivateNetwork: config.allowPrivateNetwork,
    },
    /**
     * Availability flags, not values. The dashboard branches on "can I use it?";
     * reporting *why* it is unavailable would need the secret's presence, which
     * lives outside `Config`.
     */
    features: {
      authentication: true,
      sessions: true,
      toolRouting: true,
      backendLifecycle: true,
      auditTrail: true,
      settingsMutation: false,
      metrics: false,
    },
  };
}

export interface OpsRouteDependencies {
  config: Config;
  store: Database;
  lifecycle: BackendLifecycleManager;
  catalog: ToolCatalog;
  sessions?: SessionService;
  /** `unavailable` when no hashing key is configured. */
  authentication: 'required' | 'unavailable';
  /** Injected so a test can assert a fixed uptime without sleeping. */
  now?: () => number;
}

/**
 * `/ready` lives outside the version prefix (it is infrastructure, like
 * `/health`), so it is exported separately and mounted by `createGateway`.
 *
 * Readiness is about *this process serving requests*: storage answers and the
 * migration ledger is readable. Optional backends are deliberately excluded — a
 * gateway with every backend disconnected is still ready to accept work.
 */
export function readyHandler(store: Database): (c: Context) => Response {
  return (c) => {
    const database = databaseResponds(store);
    const migration = database ? migrationVersion(store) : undefined;
    const ready = database && migration !== undefined;

    return c.json(
      {
        status: ready ? 'ready' : 'not_ready',
        checks: {
          database: database ? 'ok' : 'unavailable',
          migrations: migration === undefined ? 'unavailable' : 'ok',
        },
        ...(migration === undefined ? {} : { migrationVersion: migration }),
        timestamp: new Date().toISOString(),
      },
      ready ? 200 : 503,
    ) as unknown as Response;
  };
}

export function opsRoutes(deps: OpsRouteDependencies): Hono {
  const routes = new Hono();
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  /** Process uptime. One clock for every endpoint, so the numbers cannot drift apart. */
  const uptimeMs = (): number => Math.max(0, clock() - startedAt);

  const snapshot = (): OpsSnapshot =>
    opsSnapshot({
      store: deps.store,
      lifecycle: deps.lifecycle,
      catalog: deps.catalog,
      ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
    });

  /** Dashboard landing payload: one round trip for the numbers a home screen shows. */
  routes.get('/overview', (c) => {
    const state = snapshot();

    return ok(c, {
      service: { name: SERVICE_INFO.name, version: SERVICE_INFO.version },
      environment: deps.config.environment,
      uptimeMs: uptimeMs(),
      status: state.database === 'ok' ? 'operational' : 'degraded',
      database: state.database,
      backends: state.backends,
      tools: state.tools,
      agents: state.agents,
      sessions: state.sessions,
      activity: state.activity,
      authentication: deps.authentication,
    });
  });
  routes.get('/monitoring', (c) => ok(c, monitoringPayload()));

  routes.get('/monitoring/health', (c) => {
    const state = snapshot();

    return ok(c, {
      /** Readiness of storage, not of optional backends: those are reported below. */
      status: state.database === 'ok' ? 'ok' : 'degraded',
      database: state.database,
      backends: state.backends,
      timestamp: new Date().toISOString(),
    });
  });

  routes.get('/monitoring/backends', (c) => {
    const state = snapshot();

    return ok(c, {
      counts: state.backends,
      runtimes: deps.lifecycle.getAllRuntimeStates(),
      discovery: deps.catalog.reports(),
      conflicts: deps.catalog.conflicts$(),
    });
  });

  routes.get('/monitoring/sessions', (c) => {
    if (deps.sessions === undefined) {
      return ok(c, { available: false, counts: null, reason: 'Session tracking is not enabled.' });
    }

    const counts = deps.sessions.counts();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    return ok(c, { available: true, counts, total });
  });

  routes.get('/monitoring/runtime', (c) => ok(c, runtimePayload()));

  /** Safe facts for a bug report. Read-only by construction: nothing here writes. */
  routes.get('/diagnostics', (c) => {
    const state = snapshot();
    const database = databaseResponds(deps.store);

    return ok(c, {
      ...runtimePayload(),
      database: {
        status: database ? 'ok' : 'unavailable',
        migrationVersion: database ? (migrationVersion(deps.store) ?? null) : null,
      },
      configuration: { status: 'ok', environment: deps.config.environment, logLevel: deps.config.logLevel },
      backends: { registered: state.backends?.total ?? null },
      sessions: state.sessions === null ? null : { total: Object.values(state.sessions).reduce((sum, n) => sum + n, 0) },
      tools: { available: state.tools?.available ?? null },
      authentication: deps.authentication,
      /**
       * Every flag a misconfigured deployment is likely to have wrong, without
       * the values that would make it a disclosure.
       */
      limits: {
        requestBodyLimitBytes: deps.config.requestBodyLimitBytes,
        requestTimeoutMs: deps.config.requestTimeoutMs,
      },
    });
  });

  routes.get('/settings', (c) => ok(c, { ...publicSettings(deps.config), readOnly: true }));

  /** Machine-readable contract. Generated once at startup: it is static per process. */
  routes.get('/openapi.json', (c) => ok(c, buildOpenApi(deps.config)));

  function runtimePayload() {
    return {
      service: { name: SERVICE_INFO.name, version: SERVICE_INFO.version },
      runtime: { node: process.version, platform: process.platform, uptimeMs: uptimeMs() },
      timestamp: new Date().toISOString(),
    };
  }

  function monitoringPayload() {
    const state = snapshot();
    const counts = state.sessions;

    return {
      status: state.database === 'ok' ? 'operational' : 'degraded',
      ...runtimePayload(),
      database: state.database,
      backends: state.backends,
      sessions: counts === null ? null : { counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) },
      tools: state.tools,
      activity: state.activity,
    };
  }

  return routes;
}
