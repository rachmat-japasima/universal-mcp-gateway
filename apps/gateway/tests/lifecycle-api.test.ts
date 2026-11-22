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
 * Lifecycle endpoint contracts.
 *
 * Exercised through `app.request()` (the same surface `tests/api.test.ts` uses)
 * because these assertions are about status codes and envelopes. The child
 * process is the isolated stdio fixture — never a real backend.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture.ts', import.meta.url));

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
  directory = mkdtempSync(join(tmpdir(), 'gw-runtime-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  // Credential keys are required so the operator session minted below can be
  // verified: an empty key set makes every operator cookie fail closed.
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });
  session = createTestOperator(store, testKeys());
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

async function call({ method, path, body }: Call): Promise<Response> {
  return gateway.app.request(`/api/v1${path}`, {
    method,
    headers: body === undefined ? { ...HOST, ...session.headers } : { ...JSON_HEADERS, ...session.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function createBackend(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await call({
    method: 'POST',
    path: '/backends',
    body: {
      name: 'fixture',
      connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, 'stdio'] },
      ...overrides,
    },
  });
  expect(response.status).toBe(201);
  return (await json<{ data: Record<string, unknown> }>(response)).data;
}

describe('runtime reads', () => {
  it('reports a freshly registered backend as disconnected', async () => {
    const created = await createBackend();

    const response = await call({ method: 'GET', path: `/backends/${created.id as string}/runtime` });
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Record<string, unknown> }>(response);
    expect(data).toMatchObject({ backendId: created.id, status: 'disconnected', reconnectAttempts: 0 });
    // Nothing about the connection is exposed.
    expect(data).not.toHaveProperty('pid');
    expect(data).not.toHaveProperty('connection');
  });

  it('lists every backend runtime without treating "runtime" as an id', async () => {
    const created = await createBackend();

    const response = await call({ method: 'GET', path: '/backends/runtime' });
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Array<{ backendId: string }> }>(response);
    expect(data.map((entry) => entry.backendId)).toEqual([created.id]);
  });

  it('answers 404 for an unknown backend', async () => {
    const response = await call({
      method: 'GET',
      path: '/backends/00000000-0000-4000-8000-000000000000/runtime',
    });
    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects a malformed id', async () => {
    const response = await call({ method: 'GET', path: '/backends/not-a-uuid/runtime' });
    expect(response.status).toBe(400);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('connect, disconnect, reconnect', () => {
  it('connects, reports connected, and disconnects through the API', async () => {
    const created = await createBackend();
    const id = created.id as string;

    const connected = await call({ method: 'POST', path: `/backends/${id}/connect` });
    expect(connected.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(connected)).data).toMatchObject({ status: 'connected' });

    const disconnected = await call({ method: 'POST', path: `/backends/${id}/disconnect` });
    expect(disconnected.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(disconnected)).data).toMatchObject({
      status: 'disconnected',
    });

    const runtime = store.backendRuntime.findByBackendId(id);
    expect(runtime?.status).toBe('disconnected');
    expect(runtime?.lastConnectedAt).toBeTypeOf('string');
  });

  it('answers 409 when connecting a disabled backend and does not spawn anything', async () => {
    const created = await createBackend({ enabled: false });
    const id = created.id as string;

    const response = await call({ method: 'POST', path: `/backends/${id}/connect` });
    expect(response.status).toBe(409);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('RESOURCE_CONFLICT');
    expect(store.backendRuntime.findByBackendId(id)?.status).toBe('disabled');
  });

  it('answers 404 when connecting an unknown backend', async () => {
    const response = await call({ method: 'POST', path: '/backends/00000000-0000-4000-8000-000000000000/connect' });
    expect(response.status).toBe(404);
  });

  it('reports a failed connect as an unavailable/connection error, not a 500', async () => {
    const created = await createBackend({
      connection: { type: 'stdio', command: '/nonexistent/mcp-server', args: [] },
    });

    const response = await call({ method: 'POST', path: `/backends/${created.id as string}/connect` });
    expect(response.status).toBe(502);

    const error = await json<{ error: { code: string; message: string } }>(response);
    expect(error.error.code).toBe('BACKEND_CONNECTION_ERROR');
    // The stored command is not echoed back.
    expect(error.error.message).not.toContain('/nonexistent');
  });

  it('reconnect reopens a connection after a disconnect', async () => {
    const created = await createBackend();
    const id = created.id as string;

    await call({ method: 'POST', path: `/backends/${id}/connect` });
    await call({ method: 'POST', path: `/backends/${id}/disconnect` });

    const response = await call({ method: 'POST', path: `/backends/${id}/reconnect` });
    expect(response.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(response)).data).toMatchObject({
      status: 'connected',
      reconnectAttempts: 0,
    });
  });
});

describe('registry integration', () => {
  it('disconnects on disable and does not reconnect on enable', async () => {
    const created = await createBackend();
    const id = created.id as string;

    await call({ method: 'POST', path: `/backends/${id}/connect` });
    expect(store.backendRuntime.findByBackendId(id)?.status).toBe('connected');

    const disabled = await call({ method: 'POST', path: `/backends/${id}/disable` });
    expect(disabled.status).toBe(200);
    expect(store.backendRuntime.findByBackendId(id)?.status).toBe('disabled');

    await call({ method: 'POST', path: `/backends/${id}/enable` });
    expect(store.backendRuntime.findByBackendId(id)?.status).toBe('disconnected');
  });

  it('tears down a live connection when the backend is deleted', async () => {
    const created = await createBackend();
    const id = created.id as string;

    await call({ method: 'POST', path: `/backends/${id}/connect` });
    const removed = await call({ method: 'DELETE', path: `/backends/${id}` });
    expect(removed.status).toBe(200);

    expect(store.backendRuntime.findByBackendId(id)?.status).toBe('disconnected');
    expect((await call({ method: 'GET', path: `/backends/${id}/runtime` })).status).toBe(404);
  });

  it('does not connect anything when the gateway starts', async () => {
    const created = await createBackend();
    const id = created.id as string;

    store.backendRuntime.upsert({
      backendId: id,
      status: 'connected',
      lastConnectedAt: '2026-11-18T00:00:00.000Z',
      reconnectAttempts: 2,
      updatedAt: '2026-11-18T00:00:00.000Z',
    });

    await gateway.close();
    gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });

    expect(store.backendRuntime.findByBackendId(id)).toMatchObject({
      status: 'disconnected',
      reconnectAttempts: 0,
    });
  });
});

describe('secret handling', () => {
  it('never persists or returns a resolved env value', async () => {
    process.env.GATEWAY_TEST_TOKEN = 'super-secret-value-1234';
    try {
      const created = await createBackend({
        connection: {
          type: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', FIXTURE, 'stdio'],
          env: { FIXTURE_TOKEN: 'env:GATEWAY_TEST_TOKEN' },
        },
      });
      const id = created.id as string;

      const response = await call({ method: 'POST', path: `/backends/${id}/connect` });
      expect(response.status).toBe(200);

      // The response, the stored config, and the runtime row all stay clean.
      const body = JSON.stringify(await json(response));
      expect(body).not.toContain('super-secret-value-1234');
      expect(JSON.stringify(store.backends.findById(id))).not.toContain('super-secret-value-1234');
      expect(JSON.stringify(store.backendRuntime.findByBackendId(id))).not.toContain('super-secret-value-1234');
    } finally {
      delete process.env.GATEWAY_TEST_TOKEN;
    }
  });

  it('fails loudly on an unresolvable secret reference instead of sending it literally', async () => {
    const created = await createBackend({
      connection: {
        type: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE, 'stdio'],
        env: { FIXTURE_TOKEN: 'secret:providers/test' },
      },
    });

    const response = await call({ method: 'POST', path: `/backends/${created.id as string}/connect` });
    expect(response.status).toBe(500);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('CONFIGURATION_ERROR');
  });
});
