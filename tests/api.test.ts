import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import type { ErrorEnvelope } from '../src/shared/errors.js';
import { bearer, createTestAgent, testKeys } from './fixtures/auth.js';

/**
 * Management API contract tests.
 *
 * The app is exercised directly rather than through a socket: these tests are
 * about status codes, envelopes, and validation. Loopback enforcement is tested
 * separately below by supplying the headers a real server would see.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-api-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });
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
  headers?: Record<string, string>;
}

async function call({ method, path, body, headers }: Call): Promise<Response> {
  return gateway.app.request(`/api/v1${path}`, {
    method,
    headers: body === undefined ? { ...HOST, ...headers } : { ...JSON_HEADERS, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const errorOf = async (response: Response): Promise<ErrorEnvelope['error']> => (await json<ErrorEnvelope>(response)).error;

const stdio = { type: 'stdio' as const, command: 'node', args: ['server.js'] };
const http = { type: 'streamable-http' as const, url: 'https://backend.test/mcp' };

async function createBackend(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await call({
    method: 'POST',
    path: '/backends',
    body: { name: 'backend', connection: stdio, ...overrides },
  });
  expect(response.status).toBe(201);
  return (await json<{ data: Record<string, unknown> }>(response)).data;
}

describe('system', () => {
  it('reports service facts and an empty registry', async () => {
    const response = await call({ method: 'GET', path: '/system' });
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Record<string, unknown> }>(response);
    expect(data).toMatchObject({
      service: 'universal-mcp-gateway',
      environment: 'test',
      counts: { backends: 0 },
      capabilities: { backendConnections: true, toolRouting: true, authentication: true },
      // A hashing secret is configured for this gateway, so the MCP surface can
      // verify credentials.
      authentication: 'required',
    });
  });

  it('exposes an API health endpoint distinct from the liveness probe', async () => {
    const response = await call({ method: 'GET', path: '/system/health' });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ data: { status: 'ok' } });
  });

  it('leaves /health unchanged and working', async () => {
    const response = await gateway.app.request('/health', { headers: HOST });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status: 'ok', mcp: { backendCount: 0, status: 'empty' } });
  });

  it('counts registered backends', async () => {
    await createBackend();
    const { data } = await json<{ data: { counts: { backends: number } } }>(await call({ method: 'GET', path: '/system' }));
    expect(data.counts.backends).toBe(1);
  });
});

describe('create', () => {
  it('returns 201 with a sanitized representation and no runtime handles', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends',
      body: { name: 'local-tools', connection: stdio, description: 'stdio backend' },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();

    const backend = (await json<{ data: Record<string, unknown> }>(response)).data;
    expect(backend).toMatchObject({
      name: 'local-tools',
      description: 'stdio backend',
      transport: 'stdio',
      enabled: true,
      version: 1,
      runtime: { status: 'disconnected' },
    });
    expect(Object.keys(backend)).not.toContain('deletedAt');
    expect(store.backends.countActive()).toBe(1);
  });

  it('never echoes a secret reference value, and cannot accept a literal secret', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends',
      body: {
        name: 'with-ref',
        connection: { type: 'stdio', command: 'node', args: [], env: { API_KEY: 'env:PROVIDER_KEY' } },
      },
    });
    expect(response.status).toBe(201);
    // The stored form is a reference; no value exists to leak.
    expect(await response.text()).not.toContain('sk-');

    const rejected = await call({
      method: 'POST',
      path: '/backends',
      body: { name: 'leaky', connection: { type: 'streamable-http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer sk-live-abc' } } },
    });
    expect(rejected.status).toBe(400);
    const body = await rejected.text();
    expect(JSON.parse(body).error.code).toBe('VALIDATION_ERROR');
    expect(body).not.toContain('sk-live-abc');
  });

  it('rejects a shell string in place of an executable', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends',
      body: { name: 'shell', connection: { type: 'stdio', command: 'node server.js && rm -rf /', args: [] } },
    });

    expect(response.status).toBe(400);
    expect((await json<ErrorEnvelope>(response)).error.message).toMatch(/single executable/);
  });

  it('rejects a duplicate name with 409', async () => {
    await createBackend({ name: 'taken' });

    const response = await call({ method: 'POST', path: '/backends', body: { name: 'taken', connection: http } });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('RESOURCE_CONFLICT');
  });

  it('rejects unknown fields rather than silently dropping them', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends',
      body: { name: 'extra', connection: stdio, id: 'attacker-supplied' },
    });

    expect(response.status).toBe(400);
    expect(store.backends.countActive()).toBe(0);
  });

  it('does not echo a secret pasted into a field name or env key', async () => {
    const pasted = 'sk-live-ABCDEFGHIJKLMNOP';
    const responses = await Promise.all([
      call({
        method: 'POST',
        path: '/backends',
        body: { name: 'leaky-env', connection: { type: 'stdio', command: 'node', args: [], env: { [pasted]: 'env:OK' } } },
      }),
      call({ method: 'POST', path: '/backends', body: { name: 'leaky-field', connection: stdio, [pasted]: 1 } }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(pasted);
    }

    // A secret must never reach storage or the audit trail either.
    expect(store.backends.countActive()).toBe(0);
    expect(JSON.stringify(store.audit.list(10))).not.toContain(pasted);
  });

  it('accepts a legitimate header name and echoes only the reference', async () => {
    // A header name is caller-supplied config text, like `name`: `X-Api-Key` is
    // indistinguishable from a pasted secret, so it is displayed, not redacted.
    // The header *value* is a reference, so no secret value is ever returned.
    const created = await createBackend({
      name: 'with-header',
      connection: { type: 'streamable-http', url: 'https://x.test/mcp', headers: { 'X-Api-Key': 'secret:mcp/key' } },
    });

    expect(created).toMatchObject({ connection: { headers: { 'X-Api-Key': 'secret:mcp/key' } } });
  });

  it('records an audit event for the creation', async () => {
    const created = await createBackend({ name: 'audited' });

    const [event] = store.audit.list(1);
    expect(event).toMatchObject({ action: 'backend.created', targetId: created.id, result: 'success' });
  });
});

describe('list', () => {
  it('returns an empty page shape', async () => {
    const response = await call({ method: 'GET', path: '/backends' });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('paginates with a total count independent of the page', async () => {
    for (const name of ['a', 'b', 'c']) await createBackend({ name });

    const page = await json<{ data: Array<{ name: string }>; pagination: Record<string, number> }>(
      await call({ method: 'GET', path: '/backends?page=2&limit=2' }),
    );

    expect(page.data.map((backend) => backend.name)).toEqual(['c']);
    expect(page.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('filters by transport and enabled state', async () => {
    await createBackend({ name: 'stdio-on' });
    await createBackend({ name: 'http-on', connection: http });
    await createBackend({ name: 'stdio-off', enabled: false });

    const onlyHttp = await json<{ data: Array<{ name: string }> }>(
      await call({ method: 'GET', path: '/backends?transport=streamable-http' }),
    );
    expect(onlyHttp.data.map((backend) => backend.name)).toEqual(['http-on']);

    const disabled = await json<{ data: Array<{ name: string }> }>(
      await call({ method: 'GET', path: '/backends?enabled=false' }),
    );
    expect(disabled.data.map((backend) => backend.name)).toEqual(['stdio-off']);
  });

  it('searches names and descriptions case-insensitively', async () => {
    await createBackend({ name: 'Alpha', description: 'filesystem tools' });
    await createBackend({ name: 'beta' });

    const byName = await json<{ data: Array<{ name: string }> }>(await call({ method: 'GET', path: '/backends?search=ALP' }));
    expect(byName.data.map((backend) => backend.name)).toEqual(['Alpha']);

    const byDescription = await json<{ data: Array<{ name: string }> }>(
      await call({ method: 'GET', path: '/backends?search=filesystem' }),
    );
    expect(byDescription.data.map((backend) => backend.name)).toEqual(['Alpha']);
  });

  it('treats SQL and wildcard metacharacters as literals', async () => {
    await createBackend({ name: 'victim' });

    for (const search of ["%' OR 1=1 --", '%', '_', 'victim%']) {
      const response = await call({ method: 'GET', path: `/backends?search=${encodeURIComponent(search)}` });
      expect(response.status).toBe(200);
      expect((await json<{ pagination: { total: number } }>(response)).pagination.total).toBe(0);
    }
    expect(store.backends.countActive()).toBe(1);
  });

  it('sorts stably by name in both directions', async () => {
    for (const name of ['c', 'a', 'b']) await createBackend({ name });

    const asc = await json<{ data: Array<{ name: string }> }>(await call({ method: 'GET', path: '/backends?sort=name&order=asc' }));
    expect(asc.data.map((backend) => backend.name)).toEqual(['a', 'b', 'c']);

    const desc = await json<{ data: Array<{ name: string }> }>(await call({ method: 'GET', path: '/backends?sort=name&order=desc' }));
    expect(desc.data.map((backend) => backend.name)).toEqual(['c', 'b', 'a']);
  });

  it('rejects invalid pagination and filter values', async () => {
    for (const query of ['?limit=0', '?limit=101', '?page=0', '?page=abc', '?transport=stdio%20', '?enabled=yes', '?sort=id', '?order=sideways']) {
      const response = await call({ method: 'GET', path: `/backends${query}` });
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('read, update, and concurrency', () => {
  it('returns 404 for an unknown but well-formed id', async () => {
    const response = await call({ method: 'GET', path: '/backends/00000000-0000-4000-8000-000000000000' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects a malformed id before hitting the database', async () => {
    const response = await call({ method: 'GET', path: '/backends/not-a-uuid' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
  });

  it('round-trips a partial update without disturbing other fields', async () => {
    const created = await createBackend({ name: 'before', description: 'keep' });

    const response = await call({
      method: 'PATCH',
      path: `/backends/${created.id}`,
      body: { name: 'after' },
    });

    expect(response.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(response)).data).toMatchObject({
      name: 'after',
      description: 'keep',
      version: 2,
    });
  });

  it('rejects a stale expectedVersion with 409 and keeps the first write', async () => {
    const created = await createBackend({ name: 'contended' });

    const first = await call({
      method: 'PATCH',
      path: `/backends/${created.id}?expectedVersion=1`,
      body: { description: 'first' },
    });
    expect(first.status).toBe(200);

    const second = await call({
      method: 'PATCH',
      path: `/backends/${created.id}?expectedVersion=1`,
      body: { description: 'second' },
    });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe('RESOURCE_CONFLICT');
    expect(store.backends.findById(created.id as string)?.description).toBe('first');
  });

  it('rejects an attempt to change an immutable field', async () => {
    const created = await createBackend({ name: 'immutable' });

    for (const body of [{ id: 'x' }, { version: 99 }, { createdAt: '2020-01-01T00:00:00.000Z' }]) {
      const response = await call({ method: 'PATCH', path: `/backends/${created.id}`, body });
      expect(response.status).toBe(400);
    }
  });

  it('rejects an invalid expectedVersion', async () => {
    const created = await createBackend({ name: 'bad-version' });
    const response = await call({
      method: 'PATCH',
      path: `/backends/${created.id}?expectedVersion=0`,
      body: { name: 'x' },
    });
    expect(response.status).toBe(400);
  });
});

describe('enable and disable', () => {
  it('toggles state and audits the change', async () => {
    const created = await createBackend({ name: 'toggle' });

    const disabled = await call({ method: 'POST', path: `/backends/${created.id}/disable` });
    expect(disabled.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(disabled)).data).toMatchObject({
      enabled: false,
      runtime: { status: 'disabled' },
    });

    const enabled = await call({ method: 'POST', path: `/backends/${created.id}/enable` });
    expect((await json<{ data: Record<string, unknown> }>(enabled)).data).toMatchObject({
      enabled: true,
      runtime: { status: 'disconnected' },
    });

    const toggles = store.audit
      .list(10)
      .filter((event) => event.action === 'backend.enabled' || event.action === 'backend.disabled');
    expect(toggles.map((event) => event.action).sort()).toEqual(['backend.disabled', 'backend.enabled']);
  });

  it('is idempotent: a repeated request changes nothing', async () => {
    const created = await createBackend({ name: 'idempotent' });

    const first = await call({ method: 'POST', path: `/backends/${created.id}/enable` });
    const second = await call({ method: 'POST', path: `/backends/${created.id}/enable` });

    expect(second.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(second)).data.version).toBe(
      (await json<{ data: Record<string, unknown> }>(first)).data.version,
    );
    expect(store.audit.list(10).filter((event) => event.action === 'backend.enabled')).toHaveLength(0);
  });

  it('returns 404 for an unknown backend', async () => {
    const response = await call({ method: 'POST', path: '/backends/00000000-0000-4000-8000-000000000000/enable' });
    expect(response.status).toBe(404);
  });
});

describe('delete', () => {
  it('removes the backend from the registry but keeps its audit trail', async () => {
    const created = await createBackend({ name: 'doomed' });

    const response = await call({ method: 'DELETE', path: `/backends/${created.id}` });
    expect(response.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(response)).data).toMatchObject({ id: created.id });

    expect(store.backends.countActive()).toBe(0);
    expect((await call({ method: 'GET', path: `/backends/${created.id}` })).status).toBe(404);

    const actions = store.audit.list(10).map((event) => event.action);
    expect(actions).toContain('backend.deleted');
    expect(actions).toContain('backend.created');
  });

  it('does not need a JSON body and does not require a content type', async () => {
    const created = await createBackend({ name: 'no-body-delete' });
    const response = await call({ method: 'DELETE', path: `/backends/${created.id}` });
    expect(response.status).toBe(200);
  });

  it('refuses a second delete', async () => {
    const created = await createBackend({ name: 'twice' });
    await call({ method: 'DELETE', path: `/backends/${created.id}` });

    const again = await call({ method: 'DELETE', path: `/backends/${created.id}` });
    expect(again.status).toBe(404);
  });
});

describe('validate', () => {
  it('accepts a valid proposal without creating anything', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends/validate',
      body: { name: 'proposal', connection: http, timeoutMs: 5000 },
    });

    expect(response.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(response)).data).toMatchObject({
      valid: true,
      transport: 'streamable-http',
    });
    expect(store.backends.countActive()).toBe(0);
  });

  it('reports per-field errors with 200 and audits the failure', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends/validate',
      body: { name: '', connection: { type: 'stdio', command: '', args: [] } },
    });

    expect(response.status).toBe(200);
    const { data } = await json<{ data: { valid: boolean; errors: Array<{ path: string }> } }>(response);
    expect(data.valid).toBe(false);
    expect(data.errors.map((error) => error.path)).toEqual(expect.arrayContaining(['name']));

    expect(store.audit.list(1)[0]).toMatchObject({ action: 'backend.validation_failed', result: 'failure' });
  });

  it('is not shadowed by the :backendId route', async () => {
    // If route order were wrong, "validate" would be parsed as a UUID and 400.
    const response = await call({ method: 'POST', path: '/backends/validate', body: { name: 'x', connection: stdio } });
    expect(response.status).toBe(200);
  });

  it('does not connect, resolve DNS, or spawn anything', async () => {
    // A URL pointing at a black-hole address must still validate instantly:
    // validation is local schema work only.
    const started = Date.now();
    const response = await call({
      method: 'POST',
      path: '/backends/validate',
      body: { name: 'unreachable', connection: { type: 'streamable-http', url: 'http://10.255.255.1:9/mcp' } },
    });

    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('request hygiene', () => {
  it('rejects malformed JSON with a stable envelope', async () => {
    const response = await call({ method: 'POST', path: '/backends', body: '{"name": "broken"' });

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.requestId).toBeTruthy();
  });

  it('requires a JSON content type on body-bearing methods', async () => {
    const response = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'text/plain' },
      body: '{"name":"form-post","connection":{"type":"stdio","command":"node"}}',
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    expect(store.backends.countActive()).toBe(0);
  });

  it('rejects an oversize body', async () => {
    const response = await call({
      method: 'POST',
      path: '/backends',
      body: { name: 'big', connection: stdio, description: 'x'.repeat(config.requestBodyLimitBytes) },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/too large/);
  });

  it('answers unknown API paths with the API envelope, not HTML', async () => {
    const response = await call({ method: 'GET', path: '/nope' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('RESOURCE_NOT_FOUND');
    expect(response.headers.get('content-type')).toMatch(/json/);
  });

  it('echoes a well-formed inbound request id and replaces a malformed one', async () => {
    const kept = await call({ method: 'GET', path: '/system', headers: { 'X-Request-Id': 'trace-42' } });
    expect(kept.headers.get('X-Request-Id')).toBe('trace-42');

    const replaced = await call({ method: 'GET', path: '/system', headers: { 'X-Request-Id': '<script>' } });
    expect(replaced.headers.get('X-Request-Id')).not.toBe('<script>');
  });

  it('keeps the MCP protocol envelope on /mcp (regression)', async () => {
    const agent = createTestAgent(store, testKeys());
    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        ...bearer(agent),
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });

    // Reached the MCP transport rather than the REST guard.
    expect(response.status).toBe(200);
  });

  it('answers an unauthenticated /mcp request with a 401 challenge, not the REST envelope', async () => {
    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: { ...JSON_HEADERS, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(await json(response)).toMatchObject({ jsonrpc: '2.0', error: { message: 'Unauthorized' } });
  });
});

describe('over a real socket', () => {
  /**
   * `app.request()` cannot see what the Node adaptor does to headers: it always
   * presents a body stream and may add `Content-Length: 0`. A bodyless
   * `POST .../enable` and a `DELETE` therefore need at least one test against a
   * real listener, or the guard can regress into rejecting them in production
   * while unit tests stay green.
   */
  it('accepts bodyless enable/disable and delete without a content type', async () => {
    const created = await createBackend({ name: 'socket' });
    const server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}/api/v1`;

    try {
      const disabled = await fetch(`${base}/backends/${created.id}/disable`, { method: 'POST' });
      expect(disabled.status).toBe(200);
      expect(((await disabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);

      const deleted = await fetch(`${base}/backends/${created.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);

      // The content-type guard still applies when a body is sent.
      const rejected = await fetch(`${base}/backends`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"name":"form"}',
      });
      expect(rejected.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('loopback boundary', () => {
  it('rejects a foreign Host header with the REST envelope', async () => {
    const response = await call({ method: 'GET', path: '/system', headers: { host: 'evil.example.com' } });

    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe('AUTHORIZATION_ERROR');
    // Not the SDK's JSON-RPC shape.
    expect(error).not.toHaveProperty('jsonrpc');
  });

  it('rejects a foreign Origin header', async () => {
    const response = await call({ method: 'GET', path: '/system', headers: { origin: 'https://evil.example.com' } });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('AUTHORIZATION_ERROR');
  });

  it('allows a loopback Origin and a request with no Origin', async () => {
    expect((await call({ method: 'GET', path: '/system', headers: { origin: 'http://127.0.0.1:8787' } })).status).toBe(200);
    expect((await call({ method: 'GET', path: '/system' })).status).toBe(200);
  });

  it('rejects a missing Host header', async () => {
    const response = await gateway.app.request('/api/v1/system');
    expect(response.status).toBe(403);
  });

  it('is not mounted at all when no store is configured', async () => {
    const bare = createGateway({ config, logger });
    try {
      const response = await bare.app.request('/api/v1/system', { headers: HOST });
      expect(response.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
