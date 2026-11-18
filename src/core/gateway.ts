import {
  createMcpHandler,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/hono';
import { Hono } from 'hono';

import { API_PREFIX, createManagementApi } from '../api/index.js';
import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import { BackendLifecycleManager as Lifecycle } from '../adapters/lifecycle.js';
import type { Config } from '../config/config.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { ToolCatalog } from '../routing/catalog.js';
import { ToolDiscovery } from '../routing/discovery.js';
import { createGatewayServerFactory } from '../routing/mcp-server.js';
import { ToolRouter } from '../routing/router.js';
import { SERVICE_INFO } from '../shared/service.js';
import { AuthService } from '../auth/auth-service.js';
import { CredentialKeys } from '../auth/credential-key.js';
import { AuthorizationService } from '../auth/authorization.js';
import { mcpAuthenticate, toAuthInfo } from '../api/middleware/mcp-auth.js';
import { getRequestId } from '../api/http.js';

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

  const router =
    store !== undefined && lifecycle !== undefined && authorization !== undefined
      ? new ToolRouter({
          store,
          logger,
          lifecycle,
          catalog,
          authorization,
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

  if (store !== undefined && lifecycle !== undefined) {
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
      }),
    );
  }

  /**
   * Every MCP exchange is authenticated independently. There is no session
   * state to inherit and nothing a client sends is trusted as identity, so a
   * previously initialized session cannot be replayed as proof.
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
      return handler.fetch(
        c.req.raw,
        identity === undefined ? undefined : { authInfo: toAuthInfo(identity) },
      );
    },
  );

  return {
    app,
    catalog,
    ...(discovery === undefined ? {} : { discovery }),
    ...(router === undefined ? {} : { router }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(auth === undefined ? {} : { auth }),
    async close() {
      shuttingDown = true;
      // Order matters: stop serving, then release outbound connections, then let
      // the caller close the store. A store closed under a running teardown would
      // fail to persist a truthful runtime row.
      await handler.close();
      await lifecycle?.shutdown();
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
