import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';

import { CredentialSecretError, MIN_SECRET_LENGTH, resolveCredentialKeys } from './auth/credential-key.js';
import { loadConfig, redactConfig, ConfigError } from './config/config.js';
import { createGateway } from './core/gateway.js';
import { openStore, type Database } from './infrastructure/database/index.js';
import { createLogger } from './monitoring/logger.js';
import { describeErrorForLog } from './shared/errors.js';

/**
 * Process entry. Owns the lifecycle: config → logger → store → HTTP.
 *
 * Ordered so config failures are reported before a logger exists, and so
 * migrations always finish before the socket accepts a request.
 */

let config;
try {
  config = loadConfig();
} catch (error) {
  // No logger yet, and a bad log level must not hide a bad port.
  console.error(error instanceof ConfigError ? error.message : 'Invalid gateway configuration.');
  process.exit(1);
}

const logger = createLogger(config);

/**
 * Credential hashing key.
 *
 * Read here and never through `Config`: the value must not be reachable from
 * `redactConfig`, an API response, or a log line, so it has no representation in
 * the config object at all. `resolveCredentialKeys` owns the startup policy —
 * throw in production, fail-closed-in-per-request in development.
 */
let credentialKeys;
try {
  credentialKeys = resolveCredentialKeys(config.environment);
} catch (error) {
  logger.error(
    { requiredVariable: 'CREDENTIAL_HASH_SECRET', minimumLength: MIN_SECRET_LENGTH },
    error instanceof CredentialSecretError ? error.message : 'Credential key configuration failed',
  );
  process.exit(1);
}

if (credentialKeys.issuing === undefined) {
  logger.warn(
    { minimumLength: MIN_SECRET_LENGTH },
    'CREDENTIAL_HASH_SECRET is not set: MCP authentication will reject every request until it is',
  );
}

let store: Database;
try {
  store = openStore({ path: config.databasePath });
} catch (error) {
  logger.error({ error: describeErrorForLog(error) }, 'Database initialization failed');
  process.exit(1);
}

logger.info({ config: redactConfig(config) }, 'Configuration loaded');
logger.info({ backendCount: store.backends.countActive() }, 'Database ready');

/**
 * The remaining startup is assembly and binding, and both can fail after the
 * database is open: a bad provider wiring throws from `createGateway`, and a
 * taken port throws from `serve`. Either is a startup failure like the ones
 * above — logged, exit 1 — never an unhandled crash that leaves no reason.
 */
let gateway: ReturnType<typeof createGateway>;
let server: HttpServer;
try {
  gateway = createGateway({ config, logger, store, credentialKeys });
  // `serve` types its return as a union across http/https/http2 because it can
  // be handed a custom factory; with none, it is always `http.Server`, which is
  // where the connection-drain methods below live.
  server = serve({ fetch: gateway.app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(
      {
        host: config.host,
        port: info.port,
        health: `http://${config.host}:${info.port}${config.healthEndpoint}`,
        mcp: `http://${config.host}:${info.port}${config.mcpEndpoint}`,
      },
      'Universal MCP Gateway started',
    );
  }) as HttpServer;
} catch (error) {
  logger.error({ error: describeErrorForLog(error), host: config.host, port: config.port }, 'Gateway startup failed');
  store.close();
  process.exit(1);
}

/**
 * Ceiling on the shutdown drain, in milliseconds.
 *
 * `server.close()` stops accepting connections but waits for keep-alive
 * connections to finish; a client that holds one open forever would hold the
 * process open with it. Idle connections are reaped immediately, and anything
 * still active after this bound is force-closed, with the teardown (sessions →
 * transports → store) still running in order afterwards.
 */
const SHUTDOWN_DRAIN_LIMIT_MS = 5_000;

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gateway');

  // Idle keep-alive connections carry no work; reaping them is what makes the
  // common shutdown immediate. Only an in-flight request holds the drain open.
  server.closeIdleConnections();

  const drainDeadline = setTimeout(() => {
    logger.warn(
      { limitMs: SHUTDOWN_DRAIN_LIMIT_MS },
      'Shutdown drain deadline reached; forcing remaining connections closed',
    );
    server.closeAllConnections();
  }, SHUTDOWN_DRAIN_LIMIT_MS);

  server.close(() => {
    clearTimeout(drainDeadline);
    void gateway
      .close()
      .then(() => {
        store.close();
        logger.info('Gateway stopped');
        process.exit(process.exitCode ?? 0);
      })
      .catch((error: unknown) => {
        logger.error({ error: describeErrorForLog(error) }, 'Gateway shutdown failed');
        process.exit(1);
      });
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
