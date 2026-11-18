import { serve } from '@hono/node-server';

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

let store: Database;
try {
  store = openStore({ path: config.databasePath });
} catch (error) {
  logger.error({ error: describeErrorForLog(error) }, 'Database initialization failed');
  process.exit(1);
}

logger.info({ config: redactConfig(config) }, 'Configuration loaded');
logger.info({ backendCount: store.backends.countActive() }, 'Database ready');

const gateway = createGateway({ config, logger, store });
const server = serve({ fetch: gateway.app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info(
    {
      host: config.host,
      port: info.port,
      health: `http://${config.host}:${info.port}${config.healthEndpoint}`,
      mcp: `http://${config.host}:${info.port}${config.mcpEndpoint}`,
    },
    'Universal MCP Gateway started',
  );
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gateway');

  server.close(() => {
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
