import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

import {
  createMcpHonoApp,
  localhostHostValidation,
} from '@modelcontextprotocol/hono';

import { logger } from '../monitoring/logger.js';

export function createGatewayApp() {
  const app = createMcpHonoApp();

  // Protect the local gateway against DNS rebinding.
  app.use('*', localhostHostValidation());

  // Gateway health check.
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'universal-mcp-gateway',
      version: '1.0.0',
      mcp: {
        endpoint: '/mcp',
        backendCount: 0,
        status: 'empty',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint (stateless transport).
  app.all('/mcp', async (c) => {
    const mcpServer = new McpServer(
      {
        name: 'universal-mcp-gateway',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await mcpServer.connect(transport);

      // Pass the original Request directly to the MCP transport.
      return await transport.handleRequest(c.req.raw);
    } catch (error) {
      logger.error({ err: error }, 'MCP request failed');

      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal gateway error',
          },
          id: null,
        },
        500,
      );
    }
  });

  return app;
}
