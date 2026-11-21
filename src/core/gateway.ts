import {
  createMcpHandler,
  isLegacyRequest,
  legacyStatelessFallback,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type LegacyHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/hono';
import { Hono } from 'hono';

import { API_PREFIX, createManagementApi } from '../api/index.js';
import { readyHandler } from '../api/routes/ops.routes.js';
import { getRequestId, httpMetrics, requestCorrelation } from '../api/http.js';
import { loopbackOnly } from '../api/middleware/guards.js';
import { operatorAuth } from '../api/middleware/operator-auth.js';
import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import { BackendLifecycleManager as Lifecycle } from '../adapters/lifecycle.js';
import type { Config } from '../config/config.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { metrics } from '../monitoring/metrics.js';
import { ToolCatalog } from '../routing/catalog.js';
import { ToolDiscovery } from '../routing/discovery.js';
import { createGatewayServerFactory } from '../routing/mcp-server.js';
import { ToolRouter } from '../routing/router.js';
import { SERVICE_INFO } from '../shared/service.js';
import { AuthService } from '../auth/auth-service.js';
import { CredentialKeys } from '../auth/credential-key.js';
import { AuthorizationService } from '../auth/authorization.js';
import { mcpAuthenticate, toAuthInfo } from '../api/middleware/mcp-auth.js';
import { isInitializeBody, McpSessionManager, sessionNotFound } from '../sessions/session-manager.js';
import { SessionService } from '../registry/session-service.js';
import { OperatorService } from '../registry/operator-service.js';
import { IntegrationService } from '../integrations/service.js';
import { ProviderRegistry, providerRegistry } from '../integrations/registry.js';
import { EnvelopeVault } from '../integrations/vault.js';

export interface GatewayOptions {
  config: Config;
  logger: Logger;
  /**
   * Store used for health reporting and the management API. Omitted in protocol
   * tests that exercise the MCP surface without persistence; the API is then not
   * mounted at all rather than mounted against a missing database.
   */
  store?: Database;
  /**
   * Hashing keys for agent credentials. Loaded by the process entry, never from
   * `Config`: the secret must not be reachable from `redactConfig`, an API
   * response, or a log line. Omitted in storeless protocol mode.
   */
  credentialKeys?: CredentialKeys;
  /** Override the per-exchange server factory (used by tests to observe isolation). */
  createServer?: McpServerFactory;
  /** Injected lifecycle manager, so tests can control the clock and backoff. */
  lifecycle?: BackendLifecycleManager;
  /**
   * Injected provider registry, so tests can register fixture providers.
   * Production uses the module-level registry, which ships empty (ADR-050).
   */
  providerRegistry?: ProviderRegistry;
}

export interface Gateway {
  app: Hono;
  /** Releases in-flight MCP exchanges. Safe to call more than once. */
  close(): Promise<void>;
  /** Shared services, exposed for tests and for the management API wiring. */
  readonly catalog: ToolCatalog;
  readonly discovery?: ToolDiscovery;
  readonly router?: ToolRouter;
  readonly authorization?: AuthorizationService;
  readonly auth?: AuthService;
  readonly sessions?: SessionService;
  readonly sessionManager?: McpSessionManager;
  /** Dashboard operator authentication. Absent only when there is no store. */
  readonly operators?: OperatorService;
  /** Managed integrations (Phase 12). Absent only when there is no store. */
  readonly integrations?: IntegrationService;
}

export { SERVICE_INFO };

/**
 * Builds the MCP surface served for one exchange when no store is configured:
 * the gateway is running as a bare protocol endpoint with no backends, so the
 * catalog is empty and `tools/call` has nothing to route to.
 */
export function createEmptyServer(): McpServer {
  return new McpServer(SERVICE_INFO, { capabilities: { tools: {} } });
}

/**
 * A server that exposes nothing and calls nothing.
 *
 * Used when a request reaches the MCP handler without a resolved identity — a
 * wiring bug, never a client-reachable state because the auth middleware answers
 * first. Failing closed here means such a bug cannot become an anonymous bypass.
 */
export function createDeniedServer(): Server {
  const server = new Server(SERVICE_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', () => ({ tools: [] }));
  server.setRequestHandler('tools/call', () => {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
  });

  return server;
}

/**
 * Reads a JSON body without consuming it.
 *
 * The era classifier and the stateless leg both need the body, so the peek works
 * on a clone. Anything unreadable or non-JSON returns `undefined`, which simply
 * leaves the request on the stateless leg where the SDK answers the error.
 */
async function peekJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.clone().text());
  } catch {
    return undefined;
  }
}

/** Client-caused rejections are reported through `onerror`; they are not gateway faults. */
const CLIENT_ERROR_PREFIXES = ['Rejected inbound request', 'Rejected 2025-era request', 'Unsupported Media Type'];

export function createGateway(options: GatewayOptions): Gateway {
  const { config, logger, store } = options;

  /**
   * The catalog exists even without a store so `createGateway` has one shape.
   * It stays empty in that mode because nothing can be discovered without a
   * registry or a lifecycle.
   */
  const catalog = new ToolCatalog();

  /**
   * One lifecycle manager per process, created here so the API, the runtime
   * endpoints, and shutdown all share it. `recover()` runs before any route can
   * be reached: a persisted `connected` belongs to a process that no longer
   * exists, so it is rewritten to a resting state and never auto-reconnected.
   */
  const lifecycle =
    options.lifecycle ??
    (store === undefined
      ? undefined
      : new Lifecycle({
          store,
          logger,
          networkPolicy: { allowPrivateNetwork: config.allowPrivateNetwork },
          reconnect: {
            enabled: config.reconnectEnabled,
            initialDelayMs: config.reconnectInitialDelayMs,
            maxDelayMs: config.reconnectMaxDelayMs,
            maxAttempts: config.reconnectMaxAttempts,
            jitterRatio: config.reconnectJitterRatio,
          },
        }));

  lifecycle?.recover();

  /**
   * Discovery and routing need a registry and a lifecycle; without both there is
   * nothing to discover and nowhere to route, so the empty server stays.
   */
  const discovery =
    store !== undefined && lifecycle !== undefined
      ? new ToolDiscovery({
          store,
          logger,
          lifecycle,
          catalog,
          timeoutMs: config.toolDiscoveryTimeoutMs,
        })
      : undefined;

  /**
   * Authorization needs a store (policies) and the catalog (what exists). It is
   * built before the router so the router can enforce it, and before the MCP
   * surface so listing can filter with the same rule set.
   */
  const authorization =
    store === undefined ? undefined : new AuthorizationService({ store, catalog, logger });

  /**
   * Managed integrations (Phase 12).
   *
   * Built whenever a store exists: the provider registry ships empty, so this
   * service can never dispatch anything in production — every managed tool
   * fails closed as `TOOL_UNAVAILABLE` because `dispatchable()` has no
   * registered provider to answer for. The vault is lazy fail-closed: a
   * missing master key never blocks startup, only the first credential
   * operation (ADR-051).
   */
  const integrations =
    store === undefined
      ? undefined
      : new IntegrationService({
          store,
          registry: options.providerRegistry ?? providerRegistry,
          vault: new EnvelopeVault(),
          catalog,
          logger,
          timeoutMs: config.toolCallTimeoutMs,
        });

  const router =
    store !== undefined && lifecycle !== undefined && authorization !== undefined
      ? new ToolRouter({
          store,
          logger,
          lifecycle,
          catalog,
          authorization,
          ...(integrations === undefined ? {} : { integrations }),
          timeoutMs: config.toolCallTimeoutMs,
        })
      : undefined;

  /**
   * Wired after construction because the two services are mutually referential:
   * discovery needs the lifecycle to find clients, the lifecycle needs discovery
   * to follow connections. The observer is registered before any route can be
   * reached, so no connect can happen unobserved.
   */
  if (discovery !== undefined && lifecycle !== undefined) {
    lifecycle.setConnectionObserver(discovery.onConnectionChange);
  }

  const surface =
    router === undefined || authorization === undefined
      ? undefined
      : createGatewayServerFactory({ catalog, router, authorization, logger });

  /**
   * Persistent sessions (Phase 7).
   *
   * The service owns the database rules; the manager owns the in-process
   * transport registry. Both need a store, and the manager needs the identity-
   * scoped surface, so it is only built when both exist. Without a store the
   * gateway keeps the Phase 1–6 behaviour: stateless serving, no session ids.
   */
  /**
   * Declared before the service because the service notifies it: ending a session
   * anywhere (API, revocation, cleanup, shutdown) must also release the live
   * transport, or a dead session would keep an open server in memory.
   */
  let sessionManager: McpSessionManager | undefined;

  const sessions =
    store === undefined
      ? undefined
      : new SessionService({
          store,
          logger,
          idleTimeoutMs: config.sessionIdleTimeoutMs,
          maxLifetimeMs: config.sessionMaxLifetimeMs,
          onEnded: (ended) => {
            for (const session of ended) {
              if (session.mcpSessionId !== undefined) void sessionManager?.close(session.mcpSessionId);
            }
          },
        });

  sessionManager =
    sessions === undefined || surface === undefined
      ? undefined
      : new McpSessionManager({
          service: sessions,
          logger,
          createServer: (identity) => surface({ agent: identity.agent, credentialId: identity.credential.id }),
          maxRequestBodySize: config.requestBodyLimitBytes,
        });

  /**
   * Identity resolution for one exchange.
   *
   * The middleware has already verified the bearer token; `authInfo` is only a
   * carrier. The agent is re-read from the store so a disable or delete that
   * happened between verification and the handler is honoured, and so the server
   * instance owns a real entity rather than a claim from the wire.
   */
  const createServer: McpServerFactory =
    options.createServer ??
    ((ctx) => {
      if (surface === undefined || store === undefined) return createEmptyServer();

      const agentId = ctx.authInfo?.extra?.['agentId'];
      const credentialId = ctx.authInfo?.extra?.['credentialId'];
      if (typeof agentId !== 'string' || typeof credentialId !== 'string') return createDeniedServer();

      const agent = store.agents.findById(agentId);
      if (agent === undefined || !agent.enabled) return createDeniedServer();

      return surface({ agent, credentialId });
    });

  const handler = createMcpHandler(createServer, {
    maxRequestBodySize: config.requestBodyLimitBytes,
    onerror: (error) => {
      if (CLIENT_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))) {
        // No stack: the request was invalid, the gateway is fine.
        logger.warn({ message: error.message }, 'MCP request rejected');
        return;
      }

      logger.error({ err: error }, 'MCP handler error');
    },
  });

  /**
   * Authentication is built even without a hashing key: a missing key makes
   * `authenticate()` fail closed, which is the documented development posture,
   * and the process entry refuses to start in production.
   */
  const auth =
    store === undefined
      ? undefined
      : new AuthService({
          store,
          keys: options.credentialKeys ?? EMPTY_KEYS,
          logger,
        });

  let shuttingDown = false;
  const app = new Hono();

  /**
   * Correlation ids for every surface, mounted before any guard so even a
   * request refused by a guard is correlatable in the logs. Runs the whole
   * chain inside `AsyncLocalStorage`, which is what makes the ids readable in
   * auth, routing, transports and audit writes without a parameter threaded
   * through every signature — and what keeps concurrent requests isolated.
   */
  app.use('*', requestCorrelation);

  /**
   * Request metrics for every surface, after correlation: a request refused by
   * a later guard is still a request the process did work for, and in-flight
   * pressure from probe storms is exactly what the gauge exists to show.
   */
  app.use('*', httpMetrics(metrics));

  // DNS-rebinding defence for the MCP surface. Scoped to `/mcp` and `/health`
  // rather than `*` so the management API can answer with its own error envelope
  // (the SDK middleware replies with a JSON-RPC envelope, which a REST client
  // cannot parse). The API applies the same SDK validators itself.
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith(API_PREFIX)) return next();
    return hostHeaderValidation(localhostAllowedHostnames())(c, next);
  });
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith(API_PREFIX)) return next();
    return originValidation(localhostAllowedOrigins())(c, next);
  });

  app.get(config.healthEndpoint, (c) => {
    const backendCount = store?.backends.countActive() ?? 0;

    return c.json({
      status: 'ok',
      service: SERVICE_INFO.name,
      version: SERVICE_INFO.version,
      mcp: {
        endpoint: config.mcpEndpoint,
        backendCount,
        status: backendCount === 0 ? 'empty' : 'ready',
        // Liveness never depends on authentication state; reporting it makes a
        // misconfiguration visible without failing the probe.
        authentication: options.credentialKeys?.issuing === undefined ? 'unavailable' : 'required',
      },
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Readiness, next to liveness but with a different question: `/health` asks
   * "is this process alive?", `/ready` asks "can it serve?". It lives outside
   * the version prefix because infrastructure probes should not follow an API
   * version, and it never consults an optional backend.
   *
   * Only mounted when there is a store: without one, the gateway genuinely has
   * no evidence either way, and a `503` would be a claim it cannot support.
   */
  if (store !== undefined) {
    app.get('/ready', readyHandler(store));
  }
  /**
   * Operator authentication is built whenever there is a store, and the
   * management API is mounted only when it exists. That is the whole boundary:
   * there is no code path that serves `/api/v1` without it, so a future refactor
   * cannot quietly restore an unauthenticated management plane.
   *
   * A gateway with no operator configured still *serves* the API — it just
   * answers 401 to everything except login, which tells the operator to run
   * `pnpm operator:create` instead of failing to boot.
   */
  const operators =
    store === undefined
      ? undefined
      : new OperatorService({
          store,
          keys: options.credentialKeys ?? EMPTY_KEYS,
          logger,
          idleTimeoutMs: config.operatorSessionIdleTimeoutMs,
          maxLifetimeMs: config.operatorSessionMaxLifetimeMs,
        });

  /**
   * Live-state collectors, registered where the live objects exist. Keyed, so
   * a second assembly in the same process (tests) replaces rather than piles
   * onto the first. Both are read-only views of already-tracked state: the
   * runtime row set and the session manager's map. `undefined` collectors
   * simply never register, and the metric is then absent from an export
   * rather than fabricated as zero — a storeless gateway has no backends and
   * no sessions to count.
   */
  if (lifecycle !== undefined) {
    metrics.collect('backend-runtime', () => {
      const counts = new Map<string, number>();
      for (const view of lifecycle.getAllRuntimeStates()) {
        counts.set(view.status, (counts.get(view.status) ?? 0) + 1);
      }
      return [...counts].map(([status, value]) => ({
        name: 'umg_backend_runtime',
        help: 'Registered backends by current runtime status.',
        labels: { status },
        value,
      }));
    });
  }
  metrics.collect('mcp-sessions', () => [
    { name: 'umg_mcp_sessions_active', help: 'Live MCP protocol sessions.', value: sessionManager?.size ?? 0 },
  ]);

  if (store !== undefined && lifecycle !== undefined && operators !== undefined) {
    app.route(
      API_PREFIX,
      createManagementApi({
        config,
        logger,
        store,
        lifecycle,
        catalog,
        // `discovery` is defined whenever `store` and `lifecycle` are.
        discovery: discovery!,
        authorization: authorization!,
        credentialKeys: options.credentialKeys ?? EMPTY_KEYS,
        operators,
        // `integrations` is defined whenever `store` is.
        integrations: integrations!,
        registry: options.providerRegistry ?? providerRegistry,
        ...(sessions === undefined ? {} : { sessions }),
      }),
    );
  }

  /**
   * Prometheus text export (format 0.0.4), for a scraper running on the same
   * machine.
   *
   * Access model — both controls, deliberately:
   *   * loopback binding + the loopback guard, like the management API;
   *   * an operator session, because the numbers describe the operator's own
   *     gateway and labels include error codes and route classes; nothing here
   *     is per-user data, but "local process" is not an identity.
   *
   * Mounted only when an operator is configured, mirroring `/ready`: a route
   * that can only ever answer 401 would misinform a scraper ("endpoint exists,
   * credentials missing") instead of the truth (nothing to serve yet). It
   * appears after `pnpm operator:create` and a restart.
   *
   * The JSON twin for the dashboard is `/api/v1/monitoring/metrics`, inside
   * the versioned API's existing operator boundary.
   */
  if (store !== undefined && operators !== undefined && operators.isConfigured()) {
    app.get(
      '/metrics',
      loopbackOnly(config),
      operatorAuth({ operators, config }),
      (c) => c.text(metrics.prometheus(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }),
    );
  }

  /**
   * Every MCP exchange is authenticated independently. A previously initialized
   * session is never proof of identity: it is a routing handle that must match
   * the agent and credential on *this* request, and the check runs before the
   * SDK sees the request.
   *
   * Two eras are served differently, because the installed SDK does:
   *   * 2025-era traffic carries `mcp-session-id`, so it is served by the
   *     sessionful transport and validated against the persistent record;
   *   * 2026-era traffic is per-request by protocol design — there is no session
   *     id to bind — so identity is re-established on every exchange and a
   *     session header, if one is presented, is still validated or refused.
   *
   * The shutdown check runs first: a request during teardown is refused for a
   * reason that has nothing to do with its credential.
   */
  app.all(
    config.mcpEndpoint,
    async (c, next) => {
      if (!shuttingDown) return next();

      return c.json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Gateway is shutting down' }, id: null },
        503,
      );
    },
    auth === undefined
      ? async (_c, next) => next()
      : mcpAuthenticate({ auth, logger }),
    async (c) => {
      const identity = c.get('mcpIdentity');

      /**
       * The identity is passed as pass-through data; the SDK performs no token
       * verification of its own. When there is no identity (storeless protocol
       * mode) nothing is passed, and the empty server answers.
       */
      const authInfo = identity === undefined ? undefined : toAuthInfo(identity);

      if (sessionManager === undefined || sessions === undefined || identity === undefined) {
        return handler.fetch(c.req.raw, authInfo === undefined ? undefined : { authInfo });
      }

      /**
       * `isLegacyRequest` is the SDK's own era classifier, so the two legs can
       * never disagree about which request is which; it reads the body from a
       * clone and leaves the original readable.
       *
       * Only an initialization or a session-bearing request goes through the
       * sessionful transport. Everything else keeps the SDK's stateless leg,
       * which is why a one-shot call with no session id behaves exactly as it
       * did in Phase 6.
       */
      if (await isLegacyRequest(c.req.raw)) {
        const presented = c.req.header('mcp-session-id');
        const parsedBody = presented === undefined ? await peekJson(c.req.raw) : undefined;

        // Hono's `header()` answers `undefined` for an absent header.
        if (presented !== undefined || isInitializeBody(parsedBody)) {
          return sessionManager.handle(c.req.raw, identity, {
            ...(authInfo === undefined ? {} : { authInfo }),
            ...(parsedBody === undefined ? {} : { parsedBody }),
          });
        }

        return handler.fetch(c.req.raw, {
          ...(authInfo === undefined ? {} : { authInfo }),
          ...(parsedBody === undefined ? {} : { parsedBody }),
        });
      }

      const presented = c.req.header('mcp-session-id');
      if (presented !== undefined && 'failure' in sessions.validate(presented, identity)) {
        // The modern-era twin of the sessionful leg's refusal: same uniform 404,
        // same two counters.
        metrics.increment('umg_mcp_session_denied_total');
        metrics.increment('umg_authz_denials_total', { surface: 'session' });
        return sessionNotFound();
      }

      return handler.fetch(c.req.raw, authInfo === undefined ? undefined : { authInfo });
    },
  );

  // Event-loop delay sampling for the process' whole lifetime; `close()`
  // stops it, and `unref`-safe internals mean a bare createGateway without a
  // listener cannot keep a test process alive.
  metrics.start();

  return {
    app,
    catalog,
    ...(discovery === undefined ? {} : { discovery }),
    ...(router === undefined ? {} : { router }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(auth === undefined ? {} : { auth }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(sessionManager === undefined ? {} : { sessionManager }),
    ...(operators === undefined ? {} : { operators }),
    ...(integrations === undefined ? {} : { integrations }),
    async close() {
      shuttingDown = true;
      // Order matters: stop serving, then release outbound connections, then let
      // the caller close the store. A store closed under a running teardown would
      // fail to persist a truthful runtime row.
      //
      // Sessions are terminated *before* the transports are released and before
      // the store closes: the documented shutdown policy is "terminate, never
      // leave a row claiming to be live in a process that no longer exists".
      // Terminating first also means a request that slips in during teardown is
      // refused by the shutdown gate above, not by a half-closed session.
      try {
        sessions?.terminateAll('gateway_shutdown');
      } catch (error) {
        logger.warn({ err: error }, 'Sessions could not be terminated during shutdown');
      }
      await sessionManager?.closeAll();
      await handler.close();
      await lifecycle?.shutdown();
      metrics.stop();
    },
  };
}

/**
 * Used in storeless protocol mode, where no credential can exist at all.
 *
 * Not a failure: there is no store, so there is nothing to authenticate against.
 * `AuthService` is never built in that mode either.
 */
const EMPTY_KEYS = new CredentialKeys(undefined);

/** Re-exported so `index.ts` can report the request id in a startup warning. */
export { getRequestId };
