import { serve } from '@hono/node-server';

import { config } from './config/config.js';
import { createGatewayApp } from './core/gateway.js';
import { logger } from './monitoring/logger.js';

const app = createGatewayApp();

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    logger.info(
      {
        host: config.host,
        port: info.port,
        health: `http://${config.host}:${info.port}/health`,
        mcp: `http://${config.host}:${info.port}/mcp`,
      },
      'Universal MCP Gateway started',
    );
  },
);

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gateway');

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Gateway shutdown failed');
      process.exitCode = 1;
      return;
    }

    logger.info('Gateway stopped');
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
