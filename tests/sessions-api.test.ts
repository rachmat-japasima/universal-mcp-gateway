import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import type { ErrorEnvelope } from '../src/shared/errors.js';
import { createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';

/**
 * Session management API contract (Phase 7).
 *
 * Exercised through the app, like `api.test.ts`: status codes, envelopes,
 * pagination, filters, and — as importantly — what is *not* in a payload.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent', SESSION_IDLE_TIMEOUT_MS: '60000' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-sessions-api-'));
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

interface SessionPayload {
  id: string;
  mcpSessionId?: string;
  agentId: string;
  credentialId?: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt?: string;
  terminatedAt?: string;
  terminationReason?: string;
}

/** Creates a real session through the service, so the row is exactly what the gateway writes. */
function openSession(agent: TestAgent, mcpSessionId: string): SessionPayload {
  const { session } = gateway.sessions!.create(
    { agent: store.agents.findById(agent.id)!, credential: store.credentials.findById(agent.credentialId)! },
    mcpSessionId,
  );
  return session as unknown as SessionPayload;
}

describe('GET /sessions', () => {
  it('lists sessions with pagination metadata, newest first', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    for (const name of ['one', 'two', 'three']) openSession(agent, name);

    const response = await call({ method: 'GET', path: '/sessions?limit=2' });
    expect(response.status).toBe(200);

    const body = await json<{ data: SessionPayload[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
      response,
    );
    expect(body.data).toHaveLength(2);
    expect(body.data.map((item) => item.mcpSessionId)).toEqual(['three', 'two']);
    expect(body.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

    const second = await call({ method: 'GET', path: '/sessions?limit=2&page=2' });
    const secondBody = await json<{ data: SessionPayload[] }>(second);
    expect(secondBody.data.map((item) => item.mcpSessionId)).toEqual(['one']);
  });

  it('returns an empty page for an empty registry', async () => {
    const response = await call({ method: 'GET', path: '/sessions' });
    const body = await json<{ data: SessionPayload[] }>(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('filters by agent and by status', async () => {
    const a = createTestAgent(store, testKeys(), { name: 'a', allowTools: ['*'] });
    const b = createTestAgent(store, testKeys(), { name: 'b', allowTools: ['*'] });
    openSession(a, 'a-1');
    const terminated = openSession(b, 'b-1');
    gateway.sessions!.terminate(terminated.id);

    const byAgent = await json<{ data: SessionPayload[] }>(await call({ method: 'GET', path: `/sessions?agentId=${a.id}` }));
    expect(byAgent.data.map((item) => item.mcpSessionId)).toEqual(['a-1']);

    const byStatus = await json<{ data: SessionPayload[] }>(await call({ method: 'GET', path: '/sessions?status=terminated' }));
    expect(byStatus.data.map((item) => item.mcpSessionId)).toEqual(['b-1']);
  });

  it('filters by creation and last-activity windows', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    openSession(agent, 's-1');
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    const after = await json<{ data: SessionPayload[] }>(
      await call({ method: 'GET', path: `/sessions?createdAfter=${encodeURIComponent(past)}` }),
    );
    expect(after.data).toHaveLength(1);

    const before = await json<{ data: SessionPayload[] }>(
      await call({ method: 'GET', path: `/sessions?createdBefore=${encodeURIComponent(past)}` }),
    );
    expect(before.data).toHaveLength(0);

    const idle = await json<{ data: SessionPayload[] }>(
      await call({ method: 'GET', path: `/sessions?lastActivityAfter=${encodeURIComponent(future)}` }),
    );
    expect(idle.data).toHaveLength(0);
  });

  it('rejects an unknown status, a bad uuid, and an oversized page', async () => {
    expect((await call({ method: 'GET', path: '/sessions?status=revoked' })).status).toBe(400);
    expect((await call({ method: 'GET', path: '/sessions?agentId=nope' })).status).toBe(400);
    expect((await call({ method: 'GET', path: '/sessions?limit=1000' })).status).toBe(400);

    // The status filter is a closed set, so the reason is stated.
    const failure = await errorOf(await call({ method: 'GET', path: '/sessions?status=revoked' }));
    expect(failure.code).toBe('VALIDATION_ERROR');
  });

  it('never exposes a credential hash, a token, or transport state', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    openSession(agent, 'secret-session');

    const raw = await (await call({ method: 'GET', path: '/sessions' })).text();
    expect(raw).not.toContain(agent.authorization.replace('Bearer ', ''));
    expect(raw).not.toContain('credentialHash');
    expect(raw).not.toContain('token');
    // The protocol id is a routing handle an operator needs; it is present.
    expect(raw).toContain('secret-session');
  });
});

describe('GET /sessions/:sessionId', () => {
  it('returns one session by internal id', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    const response = await call({ method: 'GET', path: `/sessions/${created.id}` });
    expect(response.status).toBe(200);
    expect(await json<{ data: SessionPayload }>(response)).toMatchObject({
      data: { id: created.id, agentId: agent.id, mcpSessionId: 'mcp-1', status: 'active' },
    });
  });

  it('answers an unknown id with the API envelope, not a protocol id lookup', async () => {
    const response = await call({ method: 'GET', path: '/sessions/11111111-1111-4111-8111-111111111111' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects a malformed id before touching the database', async () => {
    const response = await call({ method: 'GET', path: '/sessions/not-a-uuid' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION_ERROR');
  });

  it('does not resolve a protocol session id as an internal id', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    openSession(agent, 'mcp-1');

    // The two identifiers are deliberately not interchangeable.
    const response = await call({ method: 'GET', path: '/sessions/mcp-1' });
    expect(response.status).toBe(400);
  });
});

describe('POST /sessions/:sessionId/terminate', () => {
  it('terminates with a default reason when no body is sent', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    const response = await call({ method: 'POST', path: `/sessions/${created.id}/terminate` });
    expect(response.status).toBe(200);

    const body = await json<{ data: SessionPayload }>(response);
    expect(body.data).toMatchObject({ status: 'terminated', terminationReason: 'operator_terminated' });
    expect(body.data.terminatedAt).toBeTruthy();
  });

  it('accepts an explicit reason and is idempotent', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    const first = await json<{ data: SessionPayload }>(
      await call({ method: 'POST', path: `/sessions/${created.id}/terminate`, body: { reason: 'transport_lost' } }),
    );
    expect(first.data.terminationReason).toBe('transport_lost');

    const second = await json<{ data: SessionPayload }>(
      await call({ method: 'POST', path: `/sessions/${created.id}/terminate` }),
    );
    expect(second.data).toEqual(first.data);
  });

  it('rejects an unknown reason and unknown session', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    const badReason = await call({
      method: 'POST',
      path: `/sessions/${created.id}/terminate`,
      body: { reason: 'because' },
    });
    expect(badReason.status).toBe(400);
    expect((await errorOf(badReason)).code).toBe('VALIDATION_ERROR');

    const missing = await call({
      method: 'POST',
      path: '/sessions/22222222-2222-4222-8222-222222222222/terminate',
    });
    expect(missing.status).toBe(404);
  });

  it('writes an audit row for the termination', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    await call({ method: 'POST', path: `/sessions/${created.id}/terminate` });

    const termination = store.audit
      .list(50)
      .find((event) => event.action === 'session.terminated' && event.targetId === created.id);
    expect(termination).toBeDefined();
    expect(JSON.stringify(termination)).not.toContain(agent.authorization.replace('Bearer ', ''));
  });
});

describe('POST /sessions/cleanup', () => {
  it('sweeps idle sessions and reports what changed', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    store.handle
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 120_000).toISOString(), created.id);

    const response = await call({ method: 'POST', path: '/sessions/cleanup' });
    expect(response.status).toBe(200);

    const body = await json<{ data: { expired: number; sessions: Array<{ id: string; terminationReason?: string }> } }>(
      response,
    );
    expect(body.data.expired).toBe(1);
    expect(body.data.sessions[0]).toMatchObject({ id: created.id, terminationReason: 'idle_timeout' });

    // The row is kept, and it is no longer active.
    expect(store.sessions.findById(created.id)!.status).toBe('expired');
  });

  it('is safe to repeat and never touches an active session', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const created = openSession(agent, 'mcp-1');

    const first = await json<{ data: { expired: number } }>(await call({ method: 'POST', path: '/sessions/cleanup' }));
    const second = await json<{ data: { expired: number } }>(await call({ method: 'POST', path: '/sessions/cleanup' }));

    expect(first.data.expired).toBe(0);
    expect(second.data.expired).toBe(0);
    expect(store.sessions.findById(created.id)!.status).toBe('active');
  });
});

describe('loopback boundary', () => {
  it('refuses session management from a non-loopback host', async () => {
    const response = await gateway.app.request('/api/v1/sessions', { headers: { host: '10.0.0.5:8787' } });
    expect(response.status).toBe(403);
  });
});
