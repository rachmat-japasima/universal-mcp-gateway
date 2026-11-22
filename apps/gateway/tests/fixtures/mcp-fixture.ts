/**
 * Isolated MCP backend fixture.
 *
 * Launch forms (never pointed at by production configuration — tests only):
 *   node --import tsx tests/fixtures/mcp-fixture.ts stdio
 *   node --import tsx tests/fixtures/mcp-fixture.ts http
 *   node --import tsx tests/fixtures/mcp-fixture.ts crash
 *   node --import tsx tests/fixtures/mcp-fixture.ts hang
 *
 * `http` prints one line `{"port":N}` on stdout once listening, so the test can
 * bind port 0 and still learn the address. Everything else speaks the protocol
 * on stdio.
 */
import { serve } from '@hono/node-server';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Hono } from 'hono';
import { z } from 'zod';

const mode = process.argv[2] ?? 'stdio';

if (mode === 'crash') {
  // A backend whose executable starts but cannot initialize.
  process.stderr.write('fixture: fatal, refusing to serve\n');
  process.exit(3);
}

if (mode === 'hang') {
  // Never answers the opening handshake: exercises the per-call timeout.
  process.stdout.write('');
  setInterval(() => undefined, 60_000);
} else {
  const build = (): McpServer => {
    const server = new McpServer({ name: 'gateway-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.registerTool(
      'echo',
      { description: 'Returns its input', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );

    server.registerTool(
      'env',
      { description: 'Returns one inherited env value', inputSchema: z.object({ name: z.string() }) },
      async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '' }] }),
    );

    server.registerTool('fail', { description: 'Always throws', inputSchema: z.object({}) }, async () => {
      throw new Error('fixture: tool failure');
    });

    return server;
  };

  if (mode === 'http') {
    const handler = createMcpHandler(build, {});
    const app = new Hono();
    app.all('/mcp', (c) => handler.fetch(c.req.raw));

    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      process.stdout.write(`${JSON.stringify({ port: info.port })}\n`);
    });

    const stop = (): void => {
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } else {
    serveStdio(build);
  }
}
