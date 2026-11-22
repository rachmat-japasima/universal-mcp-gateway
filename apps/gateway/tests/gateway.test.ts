import { serve, type ServerType } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { createLogger } from '../src/monitoring/logger.js';
import { SERVICE_INFO } from '../src/shared/service.js';

const testConfig = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const testLogger = createLogger(testConfig);

interface Harness {
  gateway: Gateway;
  server: ServerType;
  url: string;
  close(): Promise<void>;
}

const open: Harness[] = [];

async function startGateway(): Promise<Harness> {
  const gateway = createGateway({ config: testConfig, logger: testLogger });
  const server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const harness: Harness = {
    gateway,
    server,
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  open.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close().catch(() => undefined)));
});

const accept = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { method: 'POST', headers: { ...accept, ...headers }, body });
  return { status: response.status, text: await response.text() };
}

async function jsonRpcError(url: string, body: string, headers: Record<string, string> = {}) {
  const { status, text } = await post(url, body, headers);
  const frame = text.split('data: ').at(-1) ?? text;
  return { status, message: JSON.parse(frame) as { error?: { code: number; message: string } } };
}

function connect(url: string, name: string, modern = false) {
  const client = new Client(
    { name, version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto' } } : undefined,
  );
  return client.connect(new StreamableHTTPClientTransport(new URL(url))).then(() => client);
}

describe('MCP handshake', () => {
  it('initializes a 2025-era client and advertises only tools', async () => {
    const { url } = await startGateway();
    const client = await connect(url, 'legacy-client');

    expect(client.getServerVersion()).toEqual(SERVICE_INFO);
    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(['tools']);

    await client.close();
  });

  it('initializes a 2026-era client via server/discover', async () => {
    const { url } = await startGateway();
    const client = await connect(url, 'modern-client', true);

    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()?.name).toBe('universal-mcp-gateway');

    await client.close();
  });
});

describe('tools/list', () => {
  it('returns an empty catalog for both protocol eras', async () => {
    const { url } = await startGateway();

    for (const modern of [false, true]) {
      const client = await connect(url, modern ? 'modern' : 'legacy', modern);
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
      await client.close();
    }
  });

  it('rejects tools/call for a tool that does not exist without leaking internals', async () => {
    const { url } = await startGateway();
    const { status, message } = await jsonRpcError(
      url,
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ghost', arguments: {} } }),
    );

    expect(status).toBe(200);
    expect(message.error?.code).toBe(-32602);
    expect(message.error?.message).toContain('ghost');
    expect(message.error?.message).not.toMatch(/at .*\.ts:|node_modules/);
  });
});

describe('session isolation', () => {
  it('serves each exchange from an independent server instance', async () => {
    const created: number[] = [];
    const gateway = createGateway({
      config: testConfig,
      logger: testLogger,
      createServer: () => {
        created.push(created.length);
        return new McpServer({ name: 'counting', version: '1.0.0' }, { capabilities: { tools: {} } });
      },
    });

    const server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/mcp`;

    const clients = await Promise.all(
      Array.from({ length: 4 }, (_, index) => connect(url, `client-${index}`)),
    );
    const results = await Promise.all(clients.map((client) => client.listTools()));

    expect(results.map((result) => result.tools.length)).toEqual([0, 0, 0, 0]);
    // No mutation is shared between clients: every exchange constructs its own instance.
    expect(created.length).toBeGreaterThanOrEqual(clients.length);

    await Promise.all(clients.map((client) => client.close()));
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps concurrent clients of different eras working side by side', async () => {
    const { url } = await startGateway();
    const legacy = await connect(url, 'legacy');
    const modern = await connect(url, 'modern', true);

    const [a, b] = await Promise.all([legacy.listTools(), modern.listTools()]);
    expect(a.tools).toEqual([]);
    expect(b.tools).toEqual([]);

    await Promise.all([legacy.close(), modern.close()]);
  });
});

describe('malformed requests', () => {
  it('answers malformed JSON with a -32700 parse error', async () => {
    const { url } = await startGateway();
    const { status, message } = await jsonRpcError(url, 'not json');

    expect(status).toBe(400);
    expect(message.error?.code).toBe(-32700);
  });

  it('answers an unknown method with -32601', async () => {
    const { url } = await startGateway();
    const { status, message } = await jsonRpcError(
      url,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'does/not/exist' }),
    );

    expect(status).toBe(200);
    expect(message.error?.code).toBe(-32601);
  });

  it('rejects an empty JSON-RPC batch with -32600', async () => {
    const { url } = await startGateway();
    const { status, message } = await jsonRpcError(url, '[]');

    expect(status).toBe(400);
    expect(message.error?.code).toBe(-32600);
  });

  it('rejects an unsupported protocol version header', async () => {
    const { url } = await startGateway();
    const { status, message } = await jsonRpcError(
      url,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { 'mcp-protocol-version': '1999-01-01' },
    );

    expect(status).toBe(400);
    expect(message.error?.message).toMatch(/Unsupported protocol version/);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const { url } = await startGateway();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...accept, 'content-type': 'text/plain' },
      body: '{}',
    });

    expect(response.status).toBe(415);
    await response.body?.cancel();
  });

  it('rejects a body over the size limit with 413', async () => {
    const { url } = await startGateway();
    const oversize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'a'.repeat(5 * 1024 * 1024) },
    });
    const { status, message } = await jsonRpcError(url, oversize);

    expect(status).toBe(413);
    expect(message.error?.message).toMatch(/Payload Too Large/);
  });
});

describe('HTTP request validation', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const { gateway } = await startGateway();
    // `fetch` controls the Host header on the wire, so exercise the app directly.
    const response = await gateway.app.fetch(
      new Request('http://127.0.0.1/mcp', {
        headers: { host: 'evil.example', accept: 'text/event-stream' },
      }),
    );

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it('accepts a loopback Host header', async () => {
    const { gateway } = await startGateway();
    const response = await gateway.app.fetch(
      new Request('http://127.0.0.1/mcp', {
        headers: { host: '127.0.0.1:8787', accept: 'text/event-stream' },
      }),
    );

    expect(response.status).not.toBe(403);
    await response.body?.cancel();
  });

  it('rejects a foreign Origin header', async () => {
    const { url } = await startGateway();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...accept, origin: 'https://evil.example' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it('allows a loopback Origin', async () => {
    const { url } = await startGateway();
    const { status } = await post(url, '{"jsonrpc":"2.0","id":1,"method":"ping"}', {
      origin: 'http://127.0.0.1:3000',
    });

    expect(status).toBe(200);
  });

  it('does not hold state for client-supplied session ids', async () => {
    const { url } = await startGateway();
    const { status, text } = await post(
      url,
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      { 'mcp-session-id': 'attacker-chosen' },
    );

    // Stateless serving ignores unknown session ids instead of trusting them.
    expect(status).toBe(200);
    expect(text).not.toContain('attacker-chosen');
  });
});

describe('lifecycle', () => {
  it('stops serving MCP work after close() and tolerates a second close', async () => {
    const { gateway, url } = await startGateway();
    await gateway.close();
    await gateway.close();

    const { status, text } = await post(url, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ error: { code: -32603 } });
  });

  it('closes a connected client cleanly and refuses new sessions afterwards', async () => {
    const { gateway, url } = await startGateway();
    const client = await connect(url, 'closing');

    await expect(client.close()).resolves.toBeUndefined();

    await gateway.close();
    await expect(connect(url, 'late')).rejects.toThrow();
  });
});
