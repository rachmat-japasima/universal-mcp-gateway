import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { BackendLifecycleManager } from '../src/adapters/lifecycle.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import type { ErrorEnvelope } from '../src/shared/errors.js';
import { createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';

/**
 * Operational endpoints: overview, monitoring, readiness, diagnostics, settings,
 * activity and audit.
 *
 * The assertions that matter here are the ones a dashboard depends on: an empty
 * gateway reports zeros (not omissions), an unavailable subsystem reports
 * `null` (not zero), and nothing in a payload is a secret.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-ops-api-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function call(method: string, path: string): Promise<Response> {
  return gateway.app.request(`/api/v1${path}`, { method, headers: HOST });
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const errorOf = async (response: Response): Promise<ErrorEnvelope['error']> =>
  (await json<ErrorEnvelope>(response)).error;

/** A second lifecycle manager over the same store, for routers built in isolation. */
function gatewayLifecycle() {
  return new BackendLifecycleManager({
    store,
    logger,
    networkPolicy: { allowPrivateNetwork: false },
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1000, maxAttempts: 1, jitterRatio: 0 },
  });
}

/** Registers a backend and returns its id. */
async function registerBackend(name: string): Promise<string> {
  const response = await gateway.app.request('/api/v1/backends', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, connection: { type: 'stdio', command: 'node', args: ['server.js'] } }),
  });
  const body = await json<{ data: { id: string } }>(response);
  return body.data.id;
}

describe('overview', () => {
  it('reports legitimate zeros for an empty registry', async () => {
    const response = await call('GET', '/overview');
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Record<string, unknown> }>(response);
    expect(data).toMatchObject({
      environment: 'test',
      status: 'operational',
      database: 'ok',
      backends: { total: 0, enabled: 0, disabled: 0 },
      tools: { total: 0, available: 0, unavailable: 0, conflict: 0, backendsWithCatalog: 0 },
      agents: { total: 0, enabled: 0, disabled: 0 },
      sessions: { active: 0, expired: 0, terminated: 0, invalidated: 0 },
      activity: { total: 0 },
      authentication: 'required',
    });
    expect(typeof data['uptimeMs']).toBe('number');
  });

  it('counts registered backends and agents instead of inventing metrics', async () => {
    await registerBackend('alpha');
    createTestAgent(store, testKeys(), { name: 'bot' });

    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/overview'));
    expect(data.backends.total).toBe(1);
    expect(data.backends.enabled).toBe(1);
    expect(data.backends.disabled).toBe(0);
    // Nothing has connected, so the runtime distribution must say so.
    expect(data.backends.runtime.disconnected).toBe(1);
    expect(data.backends.runtime.connected).toBe(0);
    expect(data.agents.total).toBe(1);
  });

  it('reports `null` rather than zero when the database is unavailable', async () => {
    store.close();

    const { data } = await json<{ data: Record<string, unknown> }>(await call('GET', '/overview'));
    expect(data).toMatchObject({ status: 'degraded', database: 'unavailable', backends: null, agents: null, sessions: null });
    // The catalog is in memory, so it is still a real answer, not a null claim.
    expect(data['tools']).toMatchObject({ total: 0 });
  });

  it('never includes a credential, token, or secret', async () => {
    const agent: TestAgent = createTestAgent(store, testKeys(), { name: 'secret-holder' });
    const raw = JSON.stringify(await json(await call('GET', '/overview')));

    expect(raw).not.toContain(agent.authorization.replace('Bearer ', ''));
    expect(raw).not.toContain('credential_hash');
    expect(raw).not.toContain('test-only-credential-secret');
  });
});

describe('monitoring', () => {
  it('summarizes state without fabricating values', async () => {
    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/monitoring'));

    expect(data.status).toBe('operational');
    expect(data.database).toBe('ok');
    expect(data.runtime.node).toMatch(/^v\d+/);
    expect(data.backends.total).toBe(0);
    expect(data.sessions.total).toBe(0);
    expect(data.tools.available).toBe(0);
  });

  it('breaks sessions down by effective status', async () => {
    const agent = createTestAgent(store, testKeys(), { name: 'session-owner' });
    gateway.sessions!.create(
      { agent: store.agents.findById(agent.id)!, credential: store.credentials.findById(agent.credentialId)! },
      'mcp-session-1',
    );

    const direct = await json<{ data: Record<string, any> }>(await call('GET', '/monitoring/sessions'));
    expect(direct.data.counts).toMatchObject({ active: 1, expired: 0, terminated: 0, invalidated: 0 });
    expect(direct.data.total).toBe(1);

    const summary = await json<{ data: Record<string, any> }>(await call('GET', '/monitoring'));
    expect(summary.data.sessions).toMatchObject({ total: 1, counts: { active: 1 } });
  });

  it('reports unavailable session data as unavailable, not zero', async () => {
    // Built directly, because `createGateway` always wires sessions when a store
    // exists: this asserts the no-session branch the dashboard must handle.
    const { opsRoutes } = await import('../src/api/routes/ops.routes.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route(
      '/',
      opsRoutes({
        config,
        store,
        lifecycle: gatewayLifecycle(),
        catalog: gateway.catalog,
        authentication: 'required',
      }),
    );

    const response = await app.request('/monitoring/sessions');
    expect(await json(response)).toMatchObject({ data: { available: false, counts: null } });
  });

  it('lists backend runtime, discovery and conflicts together', async () => {
    const backendId = await registerBackend('runtime-check');
    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/monitoring/backends'));

    expect(data.counts.total).toBe(1);
    expect(data.runtimes).toEqual([expect.objectContaining({ backendId, status: 'disconnected' })]);
    expect(data.conflicts).toEqual([]);
  });

  it('answers a health summary that reflects storage, not optional backends', async () => {
    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/monitoring/health'));
    expect(data.status).toBe('ok');
    expect(data.database).toBe('ok');
  });
});

describe('readiness', () => {
  it('is ready with a working database', async () => {
    const response = await gateway.app.request('/ready', { headers: HOST });
    expect(response.status).toBe(200);

    const body = await json<Record<string, unknown>>(response);
    expect(body).toMatchObject({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
    expect(body['migrationVersion']).toBe('0005');
  });

  it('fails closed when the database is closed', async () => {
    store.close();

    const response = await gateway.app.request('/ready', { headers: HOST });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unavailable' },
    });
  });

  it('does not fail because a registered backend is disconnected', async () => {
    await registerBackend('offline');
    expect((await gateway.app.request('/ready', { headers: HOST })).status).toBe(200);
    expect((await gateway.app.request('/health', { headers: HOST })).status).toBe(200);
  });
});

describe('diagnostics', () => {
  it('reports version, runtime, migration and counts', async () => {
    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/diagnostics'));

    expect(data.service).toMatchObject({ name: 'universal-mcp-gateway', version: '1.0.0' });
    expect(data.runtime.node).toMatch(/^v\d+/);
    expect(data.database).toMatchObject({ status: 'ok', migrationVersion: '0005' });
    expect(data.configuration).toMatchObject({ status: 'ok', environment: 'test' });
    expect(data.backends).toEqual({ registered: 0 });
    expect(data.sessions).toEqual({ total: 0 });
  });

  it('is read-only: two calls do not change any row', async () => {
    const before = store.audit.count();
    await call('GET', '/diagnostics');
    await call('GET', '/diagnostics');
    expect(store.audit.count()).toBe(before);
  });

  it('never echoes environment values or secrets', async () => {
    const raw = JSON.stringify(await json(await call('GET', '/diagnostics')));
    expect(raw).not.toContain('test-only-credential-secret');
    expect(raw).not.toMatch(/CREDENTIAL_HASH_SECRET|DATABASE_PATH|process\.env/);
  });
});

describe('settings', () => {
  it('reports effective, non-secret configuration', async () => {
    const { data } = await json<{ data: Record<string, any> }>(await call('GET', '/settings'));

    expect(data).toMatchObject({
      environment: 'test',
      host: '127.0.0.1',
      port: 8787,
      endpoints: { mcp: '/mcp', health: '/health', api: '/api/v1' },
      logging: { level: 'silent' },
      readOnly: true,
    });
    expect(data.sessions.idleTimeoutMs).toBe(1_800_000);
    expect(data.features).toMatchObject({ settingsMutation: false, metrics: false });
  });

  it('exposes no secret material', async () => {
    const raw = JSON.stringify(await json(await call('GET', '/settings')));
    expect(raw).not.toContain('test-only-credential-secret');
    expect(raw).not.toMatch(/secret|token|password|authorization/i);
  });

  it('is read-only by contract', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await call(method, '/settings');
      expect(response.status).toBe(404);
    }
  });
});

describe('activity', () => {
  it('paginates with a deterministic order and a total', async () => {
    for (const type of ['mcp.initialize', 'tools.list', 'tools.call'] as const) {
      store.activity.append({
        id: crypto.randomUUID(),
        type,
        outcome: 'success',
        createdAt: new Date(Date.now() + Math.random() * 1000).toISOString(),
      });
    }

    const first = await json<{ data: Array<{ id: string }>; pagination: Record<string, number> }>(
      await call('GET', '/activity?limit=2'),
    );
    expect(first.data).toHaveLength(2);
    expect(first.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

    const second = await json<{ data: Array<{ id: string }> }>(await call('GET', '/activity?limit=2&page=2'));
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  it('filters by type, outcome, agent, backend and date range', async () => {
    const backendId = await registerBackend('activity-backend');
    store.activity.append({
      id: crypto.randomUUID(),
      type: 'tools.call',
      backendId,
      outcome: 'failure',
      errorCode: 'TOOL_UNAVAILABLE',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.activity.append({
      id: crypto.randomUUID(),
      type: 'tools.list',
      outcome: 'success',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const byType = await json<{ data: unknown[] }>(await call('GET', '/activity?type=tools.call'));
    expect(byType.data).toHaveLength(1);

    const byOutcome = await json<{ data: unknown[] }>(await call('GET', '/activity?outcome=failure'));
    expect(byOutcome.data).toHaveLength(1);

    const byBackend = await json<{ data: unknown[] }>(await call('GET', `/activity?backendId=${backendId}`));
    expect(byBackend.data).toHaveLength(1);

    const byRange = await json<{ data: unknown[] }>(
      await call('GET', '/activity?after=2026-05-01T00:00:00.000Z&before=2026-07-01T00:00:00.000Z'),
    );
    expect(byRange.data).toHaveLength(1);
  });

  it('rejects unknown filter values instead of silently returning nothing', async () => {
    for (const query of ['?type=tools.explode', '?outcome=maybe', '?order=sideways', '?limit=101', '?page=0']) {
      const response = await call('GET', `/activity${query}`);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a malformed date and an invalid id', async () => {
    expect((await call('GET', '/activity?after=yesterday')).status).toBe(400);
    expect((await call('GET', '/activity/not-a-uuid')).status).toBe(400);
  });

  it('returns one event by id, and 404 for an unknown one', async () => {
    const id = crypto.randomUUID();
    store.activity.append({ id, type: 'tools.list', outcome: 'success', createdAt: new Date().toISOString() });

    const found = await call('GET', `/activity/${id}`);
    expect(found.status).toBe(200);
    expect((await json<{ data: { id: string } }>(found)).data.id).toBe(id);

    const missing = await call('GET', `/activity/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('never carries tool arguments or results', async () => {
    store.activity.append({
      id: crypto.randomUUID(),
      type: 'tools.call',
      toolName: 'demo__echo',
      outcome: 'success',
      createdAt: new Date().toISOString(),
    });

    const raw = JSON.stringify(await json(await call('GET', '/activity')));
    expect(raw).not.toMatch(/arguments|result/);
  });
});

describe('audit', () => {
  function appendAction(action: 'backend.created' | 'agent.created' | 'auth.failed'): string {
    const id = crypto.randomUUID();
    store.audit.append({
      id,
      actorType: action === 'auth.failed' ? 'agent' : 'admin',
      ...(action === 'auth.failed' ? { actorId: 'agent-1' } : {}),
      action,
      targetType: action === 'auth.failed' ? undefined : action.startsWith('backend') ? 'backend' : 'agent',
      targetId: crypto.randomUUID(),
      result: action === 'auth.failed' ? 'failure' : 'success',
      metadata: { note: 'bounded' },
      createdAt: new Date().toISOString(),
    } as never);
    return id;
  }

  it('omits metadata from the list and includes it in the detail', async () => {
    const id = appendAction('backend.created');

    const list = await json<{ data: Array<Record<string, unknown>> }>(await call('GET', '/audit'));
    expect(list.data[0]).not.toHaveProperty('metadata');

    const detail = await json<{ data: Record<string, unknown> }>(await call('GET', `/audit/${id}`));
    expect(detail.data).toMatchObject({ id, metadata: { note: 'bounded' } });
  });

  it('filters by action, actor, target, result and date range', async () => {
    appendAction('backend.created');
    appendAction('agent.created');
    appendAction('auth.failed');

    const byAction = await json<{ data: unknown[] }>(await call('GET', '/audit?action=auth.failed'));
    expect(byAction.data).toHaveLength(1);

    const byActor = await json<{ data: unknown[] }>(await call('GET', '/audit?actorType=agent'));
    expect(byActor.data).toHaveLength(1);

    const byResult = await json<{ data: unknown[] }>(await call('GET', '/audit?result=failure'));
    expect(byResult.data).toHaveLength(1);

    const byTarget = await json<{ data: unknown[] }>(await call('GET', '/audit?targetType=backend'));
    expect(byTarget.data).toHaveLength(1);

    const empty = await json<{ data: unknown[] }>(
      await call('GET', '/audit?after=2100-01-01T00:00:00.000Z'),
    );
    expect(empty.data).toEqual([]);
  });

  it('is append-only through the API: no write verb exists', async () => {
    const id = appendAction('agent.created');

    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect((await call(method, '/audit')).status).toBe(404);
      expect((await call(method, `/audit/${id}`)).status).toBe(404);
    }
    expect(store.audit.count()).toBe(1);
  });

  it('validates filter values and ids', async () => {
    expect((await call('GET', '/audit?action=backend.melted')).status).toBe(400);
    expect((await call('GET', '/audit?targetType=planet')).status).toBe(400);
    expect((await call('GET', '/audit?actorType=root')).status).toBe(400);
    expect((await call('GET', '/audit/nope')).status).toBe(400);
  });

  it('stays distinct from activity', async () => {
    appendAction('backend.created');
    const activity = await json<{ data: unknown[] }>(await call('GET', '/activity'));
    expect(activity.data).toEqual([]);
  });
});

describe('request correlation and error shape', () => {
  it('echoes a supplied request id on new endpoints', async () => {
    const response = await gateway.app.request('/api/v1/overview', {
      headers: { ...HOST, 'X-Request-Id': 'ops-123' },
    });
    expect(response.headers.get('X-Request-Id')).toBe('ops-123');
  });

  it('reports a safe validation error on a bad query', async () => {
    const response = await call('GET', '/activity?limit=9999');
    const error = await errorOf(response);

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.requestId).toBeTruthy();
    expect(JSON.stringify(error)).not.toMatch(/at |sqlite|SELECT/i);
  });
});
