import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve, type ServerType } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { correlationContext, enrichCorrelation, runWithCorrelation } from '../src/monitoring/context.js';
import { createLogger } from '../src/monitoring/logger.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Request correlation (Phase 11): two ids per exchange, validated when
 * inbound, generated when not, isolated per request, and propagated into the
 * stores that outlive the exchange.
 *
 * The distinction under test:
 *   * `requestId` — one HTTP exchange, echoed as `X-Request-Id`;
 *   * `correlationId` — one client task, may span requests, carried in logs
 *     and on activity rows;
 *   * the MCP session id is a routing handle and stays out of both.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent', ALLOW_PRIVATE_NETWORK: 'true' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let directory: string;
let store: Database;
let gateway: Gateway;
let session: TestOperatorSession;
let agent: TestAgent;
let server: ServerType;
let mcpUrl: string;
let client: Client | undefined;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gw-correlation-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  const keys = testKeys();
  gateway = createGateway({ config, logger, store, credentialKeys: keys });
  session = createTestOperator(store, keys);
  agent = createTestAgent(store, keys, { allowTools: ['*'] });

  // The MCP *client* speaks real HTTP, so a live listener is needed; every
  // other assertion uses the in-process `app.request`.
  server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function startBackend(): Promise<string> {
  const created = await gateway.app.request('/api/v1/backends', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...session.headers },
    body: JSON.stringify({
      name: 'fixture',
      connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, 'a'] },
    }),
  });
  expect(created.status).toBe(201);
  const { data } = (await created.json()) as { data: { id: string } };

  const connected = await gateway.app.request(`/api/v1/backends/${data.id}/connect`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...session.headers },
  });
  expect(connected.status).toBe(200);
  return data.id;
}

/** An MCP client whose every HTTP request carries the given correlation id. */
async function connectClient(correlationId: string): Promise<Client> {
  const created = new Client({ name: 'correlation-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await created.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { ...bearer(agent), 'X-Correlation-Id': correlationId } },
    }),
  );
  client = created;
  return created;
}

describe('correlation middleware', () => {
  it('generates both ids when none are supplied and echoes the request id', async () => {
    const response = await gateway.app.request('/api/v1/overview', { headers: { ...HOST, ...session.headers } });

    expect(response.status).toBe(200);
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID_PATTERN);
  });

  it('honours a well-formed inbound request id and correlation id', async () => {
    const response = await gateway.app.request('/api/v1/overview', {
      headers: { ...HOST, ...session.headers, 'X-Request-Id': 'client-req-42', 'X-Correlation-Id': 'task-abc_1' },
    });

    expect(response.headers.get('x-request-id')).toBe('client-req-42');
  });

  it('replaces a malformed inbound id instead of trusting or rejecting it', async () => {
    for (const bad of ['not an id!', 'x'.repeat(65), 'ids/cannot/slash', 'ünïcode', '']) {
      const response = await gateway.app.request('/api/v1/overview', {
        headers: { ...HOST, ...session.headers, 'X-Request-Id': bad },
      });

      const requestId = response.headers.get('x-request-id');
      expect(requestId).not.toBe(bad);
      expect(requestId).toMatch(bad === '' ? UUID_PATTERN : /^[A-Za-z0-9._-]{1,64}$/);
    }
  });

  it('covers every surface, not just the versioned API', async () => {
    for (const [path, id] of [
      ['/health', 'probe-health'],
      ['/ready', 'probe-ready'],
    ] as const) {
      const response = await gateway.app.request(path, { headers: { ...HOST, 'X-Request-Id': id } });
      expect(response.headers.get('x-request-id')).toBe(id);
    }
  });

  it('echoes the request id on a raw SDK response from the MCP surface', async () => {
    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        'X-Request-Id': 'mcp-exchange-7',
        ...bearer(agent),
        'mcp-session-id': 'not-a-real-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect([404, 200]).toContain(response.status);
    expect(response.headers.get('x-request-id')).toBe('mcp-exchange-7');
  });

  it('gives concurrent requests isolated ids', async () => {
    const responses = await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        gateway.app.request('/api/v1/overview', {
          headers: { ...HOST, ...session.headers, 'X-Request-Id': `conc-${tag}` },
        }),
      ),
    );

    const ids = responses.map((response) => response.headers.get('x-request-id'));
    expect(ids).toEqual(['conc-a', 'conc-b', 'conc-c']);
  });

  it('leaves no context behind after a failed request', async () => {
    // A request that fails mid-chain must not leak its ids to the next one.
    await gateway.app.request('/api/v1/overview', {
      headers: { ...HOST, 'X-Request-Id': 'doomed' }, // no operator session -> 401
    });

    expect(correlationContext()).toBeUndefined();

    const next = await gateway.app.request('/api/v1/overview', {
      headers: { ...HOST, ...session.headers, 'X-Request-Id': 'after-error' },
    });
    expect(next.headers.get('x-request-id')).toBe('after-error');
  });
});

describe('correlation context (AsyncLocalStorage)', () => {
  it('keeps concurrent contexts isolated across awaits', async () => {
    const seen: string[] = [];

    await Promise.all(
      ['one', 'two'].map((id) =>
        runWithCorrelation({ requestId: `r-${id}`, correlationId: `c-${id}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'one' ? 10 : 1));
          seen.push(correlationContext()!.correlationId);
        }),
      ),
    );

    expect(seen.sort()).toEqual(['c-one', 'c-two']);
  });

  it('enriches only the live request context, and ignores empties', async () => {
    enrichCorrelation({ agentId: 'outside' });
    expect(correlationContext()).toBeUndefined();

    await runWithCorrelation({ requestId: 'r', correlationId: 'c' }, async () => {
      enrichCorrelation({ agentId: 'agent-1', sessionId: '', backendId: undefined });
      expect(correlationContext()).toMatchObject({ agentId: 'agent-1' });
      expect(correlationContext()).not.toHaveProperty('sessionId');
    });

    expect(correlationContext()).toBeUndefined();
  });

  it('pops the context when the request rejects', async () => {
    await expect(
      runWithCorrelation({ requestId: 'r', correlationId: 'c' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(correlationContext()).toBeUndefined();
  });
});

describe('correlation in the persistent trails', () => {
  it('names the exchange on an MCP auth failure audit row', async () => {
    // Before Phase 11 the MCP surface had no request id at all: this row
    // carried 'unknown'. It must now carry the presented id.
    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', 'X-Request-Id': 'auth-fail-9' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);

    const { items } = store.audit.query({ action: 'auth.failed', limit: 10, offset: 0, order: 'desc' });
    expect(items.some((row) => row.requestId === 'auth-fail-9')).toBe(true);
  });

  it('persists the correlation id of a client task on activity rows', async () => {
    const backendId = await startBackend();
    const mcp = await connectClient('task-7f.2');

    const result = await mcp.callTool({ name: `${backendId}__echo`, arguments: { text: 'hello' } });
    expect(result.isError).not.toBe(true);

    const { items } = store.activity.query({ type: 'tools.call', limit: 10, offset: 0, order: 'desc' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((row) => row.correlationId === 'task-7f.2')).toBe(true);
    // The JSON-RPC id remains the row's request handle, unchanged.
    expect(items.every((row) => row.requestId !== 'unknown')).toBe(true);
  });
});
