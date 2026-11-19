import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { testKeys } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Tool catalog API and lifecycle→catalog wiring.
 *
 * Uses the real `createGateway` composition root, so the connection observer is
 * wired exactly as in production: connecting a backend must populate the catalog
 * without any explicit refresh, and disconnecting must empty it.
 *
 * Every backend is a local stdio fixture. No real MCP server is involved.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;
/** Operator session: every `/api/v1` route requires one (Phase 10.0). */
let session: TestOperatorSession;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-tools-api-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({
    config: loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent', ALLOW_PRIVATE_NETWORK: 'true' }),
    logger,
    store,
    credentialKeys: testKeys(),
  });
  session = createTestOperator(store, testKeys());
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function call(method: string, path: string): Promise<Response> {
  return gateway.app.request(`/api/v1${path}`, {
    method,
    headers: method === 'GET' ? { ...HOST, ...session.headers } : { ...JSON_HEADERS, ...session.headers },
  });
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function createBackend(name: string, mode: string): Promise<string> {
  const response = await gateway.app.request('/api/v1/backends', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...session.headers },
    body: JSON.stringify({
      name,
      connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, mode] },
    }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

/** Connects and waits for the observer-driven discovery to settle. */
async function connect(backendId: string): Promise<void> {
  const response = await call('POST', `/backends/${backendId}/connect`);
  expect(response.status).toBe(200);

  await until(async () => gateway.catalog.listByBackend(backendId).length > 0);
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met before timeout');
}

describe('lifecycle wiring', () => {
  it('discovers tools on connect and drops them on disconnect', async () => {
    const id = await createBackend('backend-a', 'a');
    await connect(id);

    const publicName = `${id}__search_items`;
    expect(gateway.catalog.resolve(publicName)).toHaveProperty('tool');

    const response = await call('POST', `/backends/${id}/disconnect`);
    expect(response.status).toBe(200);

    await until(() => gateway.catalog.listByBackend(id).length === 0);
    expect(gateway.catalog.resolve(publicName)).toEqual({ reason: 'unknown' });
  });

  it('drops tools when a backend is disabled while connected', async () => {
    const id = await createBackend('backend-a', 'a');
    await connect(id);
    expect(gateway.catalog.listByBackend(id).length).toBeGreaterThan(0);

    const response = await call('POST', `/backends/${id}/disable`);
    expect(response.status).toBe(200);

    await until(() => gateway.catalog.listByBackend(id).length === 0);
  });
});

describe('GET /tools', () => {
  it('is empty before any backend connects', async () => {
    const response = await call('GET', '/tools');
    expect(response.status).toBe(200);

    const body = await json<{ data: unknown[]; pagination: { total: number } }>(response);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('lists discovered tools with paging, filters, and a schema the client needs', async () => {
    const a = await createBackend('backend-a', 'a');
    const b = await createBackend('backend-b', 'b');
    await connect(a);
    await connect(b);

    const all = await json<{ data: Array<Record<string, unknown>>; pagination: { total: number } }>(
      await call('GET', '/tools?limit=100'),
    );
    expect(all.pagination.total).toBeGreaterThanOrEqual(6);

    const first = all.data[0]!;
    expect(first).toMatchObject({
      backendId: expect.any(String),
      publicName: expect.any(String),
      originalName: expect.any(String),
      availability: 'available',
      inputSchema: expect.any(Object),
    });
    // Internal routing state never leaves the gateway.
    expect(Object.keys(first).sort()).toEqual([
      'availability',
      'backendId',
      'description',
      'discoveredAt',
      'inputSchema',
      'originalName',
      'publicName',
      'updatedAt',
    ]);

    const paged = await json<{ data: unknown[]; pagination: { total: number; totalPages: number } }>(
      await call('GET', '/tools?limit=2&page=2'),
    );
    expect(paged.data).toHaveLength(2);
    expect(paged.pagination).toEqual({ page: 2, limit: 2, total: all.pagination.total, totalPages: Math.ceil(all.pagination.total / 2) });

    const filtered = await json<{ data: Array<{ backendId: string }> }>(
      await call('GET', `/tools?backendId=${b}&limit=100`),
    );
    expect(filtered.data.every((tool) => tool.backendId === b)).toBe(true);

    const searched = await json<{ data: Array<{ publicName: string }> }>(
      await call('GET', '/tools?search=create_item&limit=100'),
    );
    expect(searched.data.map((tool) => tool.publicName)).toEqual([`${b}__create_item`]);
  });

  it('rejects an invalid filter rather than ignoring it', async () => {
    const response = await call('GET', '/tools?availability=maybe');
    expect(response.status).toBe(400);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /tools/:publicName', () => {
  it('returns one tool and 404s an unknown one', async () => {
    const id = await createBackend('backend-a', 'a');
    await connect(id);

    const found = await call('GET', `/tools/${id}__echo`);
    expect(found.status).toBe(200);

    const missing = await call('GET', '/tools/nope__nope');
    expect(missing.status).toBe(404);
    expect((await json<{ error: { code: string } }>(missing)).error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('discovery and conflicts endpoints', () => {
  it('reports the last discovery per backend', async () => {
    const id = await createBackend('backend-a', 'a');
    await connect(id);

    const response = await call('GET', '/tools/discovery');
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Array<Record<string, unknown>> }>(response);
    expect(data).toEqual([
      expect.objectContaining({ backendId: id, status: 'ok', rejectedCount: 0, conflictCount: 0 }),
    ]);
  });

  it('reports an empty conflict list when names do not collide', async () => {
    const a = await createBackend('backend-a', 'a');
    const b = await createBackend('backend-b', 'b');
    await connect(a);
    await connect(b);

    // Different backend ids produce different public names.
    const { data } = await json<{ data: unknown[] }>(await call('GET', '/tools/conflicts'));
    expect(data).toEqual([]);
  });

  it('refreshes one backend and reports the failure of another', async () => {
    const ok = await createBackend('backend-a', 'a');
    const broken = await createBackend('backend-listfail', 'listfail');
    await connect(ok);

    // This one connects but cannot list: discovery fails, and the connection
    // itself stays up, which is exactly the partial-failure case.
    const connected = await call('POST', `/backends/${broken}/connect`);
    expect(connected.status).toBe(200);

    const one = await call('POST', `/backends/${ok}/tools/refresh`);
    expect(one.status).toBe(200);
    expect((await json<{ data: { refreshed: boolean } }>(one)).data.refreshed).toBe(true);

    const failed = await call('POST', `/backends/${broken}/tools/refresh`);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect((await json<{ error: { code: string } }>(failed)).error.code).toBe('BACKEND_CONNECTION_ERROR');

    // A bulk refresh never throws for one bad backend; it reports per backend.
    const bulk = await call('POST', '/tools/refresh');
    expect(bulk.status).toBe(200);
    const body = await json<{ data: { refreshed: number; failed: number } }>(bulk);
    expect(body.data.refreshed).toBeGreaterThanOrEqual(1);
    expect(body.data.failed).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('lists the tools of one backend with its discovery report', async () => {
    const id = await createBackend('backend-b', 'b');
    await connect(id);

    const response = await call('GET', `/backends/${id}/tools?limit=100`);
    expect(response.status).toBe(200);

    const body = await json<{ data: Array<{ backendId: string }>; discovery: { backendId: string } }>(response);
    expect(body.data.every((tool) => tool.backendId === id)).toBe(true);
    expect(body.discovery.backendId).toBe(id);
  });

  /**
   * Phase 8 tightened this: an unknown backend id is a `404`, not a `200` with
   * an empty list. A dashboard typo must not look like "this backend has no
   * tools". The filter-by-backend path on `/tools` still answers an empty page,
   * because that is a query over a collection rather than a sub-resource.
   */
  it('rejects an unknown backend id', async () => {
    const response = await call('GET', '/backends/00000000-0000-4000-8000-000000000000/tools');
    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('RESOURCE_NOT_FOUND');

    const invalid = await call('GET', '/backends/not-a-uuid/tools');
    expect(invalid.status).toBe(400);
  });
});

describe('refreshing tracks catalog changes', () => {
  it('adds and removes tools across a reconnect', async () => {
    const id = await createBackend('backend-a', 'a');
    await connect(id);
    expect(gateway.catalog.resolve(`${id}__search_items`)).toHaveProperty('tool');

    // Same backend record, different catalog.
    const patched = await gateway.app.request(`/api/v1/backends/${id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...session.headers },
      body: JSON.stringify({
        connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, 'a2'] },
      }),
    });
    expect(patched.status).toBe(200);

    await call('POST', `/backends/${id}/connect`);
    await until(() => gateway.catalog.resolve(`${id}__brand_new`).hasOwnProperty('tool'));

    expect(gateway.catalog.resolve(`${id}__search_items`)).toEqual({ reason: 'unknown' });
  });
});
