import { serve, type ServerType } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * The gateway's MCP surface over a real loopback listener.
 *
 * Everything below goes through HTTP: no direct catalog inspection decides a
 * pass. Both protocol eras are exercised, because the wire shapes differ and
 * the project supports both.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({
  ENVIRONMENT: 'test',
  LOG_LEVEL: 'silent',
  ALLOW_PRIVATE_NETWORK: 'true',
});
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;
/** Operator session: the management API rejects anonymous callers (Phase 10.0). */
let session: TestOperatorSession;
let server: ServerType;
let url: string;
const clients: Client[] = [];

/** One agent per test, allowed every tool: these tests are about routing, not access. */
let agent: TestAgent;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gw-mcp-tools-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  const keys = testKeys();
  gateway = createGateway({ config, logger, store, credentialKeys: keys });
  session = createTestOperator(store, keys);
  agent = createTestAgent(store, keys, { allowTools: ['*'] });

  server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function startBackend(name: string, mode: string): Promise<string> {
  const created = await gateway.app.request('/api/v1/backends', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...session.headers },
    body: JSON.stringify({
      name,
      connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, mode] },
    }),
  });
  expect(created.status).toBe(201);
  const { data } = (await created.json()) as { data: { id: string } };

  const connected = await gateway.app.request(`/api/v1/backends/${data.id}/connect`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...session.headers },
  });
  expect(connected.status).toBe(200);

  await until(() => gateway.catalog.listByBackend(data.id).length > 0);
  return data.id;
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met before timeout');
}

async function connect(modern: boolean, identity: TestAgent = agent): Promise<Client> {
  const client = new Client(
    { name: modern ? 'modern' : 'legacy', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto' } } : undefined,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: bearer(identity) },
    }),
  );
  clients.push(client);
  return client;
}

describe('tools/list over MCP', () => {
  it('publishes the discovered catalog to both eras, without internal fields', async () => {
    const id = await startBackend('backend-a', 'a');

    for (const modern of [false, true]) {
      const client = await connect(modern);
      const { tools } = await client.listTools();

      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [`broken_schema`, `echo`, `get_status`, `search_items`, `slow`].map((name) => `${id}__${name}`).sort(),
      );

      const search = tools.find((tool) => tool.name === `${id}__search_items`)!;
      expect(search.description).toBe('Search A');
      // The remote schema is advertised byte-for-byte: `$defs`/`$ref` intact.
      expect(search.inputSchema).toMatchObject({
        $defs: { Filter: { type: 'object' } },
        properties: { filter: { $ref: '#/$defs/Filter' } },
        additionalProperties: false,
        'x-fixture': 'preserved',
      });

      // Routing internals are not part of the protocol payload.
      expect(search).not.toHaveProperty('backendId');
      expect(search).not.toHaveProperty('originalName');
      expect(search).not.toHaveProperty('availability');
    }
  });

  it('returns an empty list when nothing is connected', async () => {
    const client = await connect(false);
    expect((await client.listTools()).tools).toEqual([]);
  });
});

describe('tools/call over MCP', () => {
  it('routes a call to the owning backend and returns its result', async () => {
    const id = await startBackend('backend-b', 'b');

    for (const modern of [false, true]) {
      const client = await connect(modern);
      const result = await client.callTool({
        name: `${id}__create_item`,
        arguments: { kind: 'b', name: 'widget' },
      });

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain('"backend":"b"');
    }
  });

  it('answers an unknown tool with InvalidParams and no internal detail', async () => {
    await startBackend('backend-a', 'a');
    const client = await connect(false);

    await expect(client.callTool({ name: 'ghost__tool', arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('rejects arguments that do not satisfy the backend schema', async () => {
    const id = await startBackend('backend-b', 'b');
    const client = await connect(false);

    await expect(
      client.callTool({ name: `${id}__create_item`, arguments: { kind: 'nope' } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('surfaces a backend-level tool error as an isError result, not a protocol error', async () => {
    const id = await startBackend('backend-b', 'b');
    const client = await connect(false);

    const result = await client.callTool({ name: `${id}__fail`, arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('fixture: tool failure');
  });

  it('stops routing once the backend disconnects', async () => {
    const id = await startBackend('backend-a', 'a');
    const client = await connect(false);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const disconnected = await gateway.app.request(`/api/v1/backends/${id}/disconnect`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
    });
    expect(disconnected.status).toBe(200);
    await until(() => gateway.catalog.listByBackend(id).length === 0);

    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: `${id}__echo`, arguments: { text: 'x' } })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('forwards arguments unvalidated when the remote schema cannot compile', async () => {
    const id = await startBackend('backend-a', 'a');
    const client = await connect(false);

    const result = await client.callTool({ name: `${id}__broken_schema`, arguments: { anything: 1 } });
    expect((result.content[0] as { text: string }).text).toContain('anything');
  });

  it('serves concurrent calls from two clients without crossing results', async () => {
    const id = await startBackend('backend-a', 'a');
    const [first, second] = await Promise.all([connect(false), connect(true)]);

    const [a, b] = await Promise.all([
      first.callTool({ name: `${id}__echo`, arguments: { text: 'from-1' } }),
      second.callTool({ name: `${id}__echo`, arguments: { text: 'from-2' } }),
    ]);

    expect((a.content[0] as { text: string }).text).toContain('from-1');
    expect((b.content[0] as { text: string }).text).toContain('from-2');
  });
});
