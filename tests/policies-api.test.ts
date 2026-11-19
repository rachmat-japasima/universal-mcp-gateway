import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { createTestAgent, testKeys } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Policy and effective-access API contract (Phase 8 completion).
 *
 * The one behaviour this file exists for: `pagination.total` must describe the
 * *filtered* set. The earlier implementation filtered `backendId` after slicing
 * a page, so a page could be short and its total wrong — a dashboard would show
 * "3 policies" above 1 row.
 */

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
  directory = mkdtempSync(join(tmpdir(), 'gw-policy-api-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });
  session = createTestOperator(store, testKeys());
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return gateway.app.request(`/api/v1${path}`, {
    method,
    headers: body === undefined ? { ...HOST, ...session.headers } : { ...JSON_HEADERS, ...session.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createBackend(name: string): Promise<string> {
  const response = await call('POST', '/backends', {
    name,
    connection: { type: 'stdio', command: 'node', args: ['server.js'] },
  });
  return (await json<{ data: { id: string } }>(response)).data.id;
}

async function createPolicy(name: string, rules: unknown[]): Promise<string> {
  const response = await call('POST', '/policies', { name, rules });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

describe('policy filtering', () => {
  it('applies backendId in the query so total describes the filtered set', async () => {
    const backendId = await createBackend('filter-backend');
    await createPolicy('matches-exactly', [{ resource: 'backend', target: backendId, effect: 'allow' }]);
    await createPolicy('matches-wildcard', [{ resource: 'backend', target: '*', effect: 'allow' }]);
    await createPolicy('does-not-match', [{ resource: 'tool', target: 'other__tool', effect: 'allow' }]);

    for (const limit of [1, 2, 100]) {
      const response = await call('GET', `/policies?backendId=${backendId}&limit=${limit}`);
      expect(response.status).toBe(200);

      const body = await json<{ data: unknown[]; pagination: Record<string, number> }>(response);
      expect(body.pagination.total).toBe(2);
      expect(body.pagination.totalPages).toBe(Math.ceil(2 / limit));
      expect(body.data).toHaveLength(Math.min(limit, 2));
    }
  });

  it('pages a filtered set without repeating or dropping rows', async () => {
    const backendId = await createBackend('paged-backend');
    for (const name of ['a', 'b', 'c']) {
      await createPolicy(name, [{ resource: 'backend', target: backendId, effect: 'allow' }]);
    }

    const first = await json<{ data: Array<{ id: string }> }>(
      await call('GET', `/policies?backendId=${backendId}&limit=2&page=1`),
    );
    const second = await json<{ data: Array<{ id: string }> }>(
      await call('GET', `/policies?backendId=${backendId}&limit=2&page=2`),
    );

    const ids = [...first.data, ...second.data].map((policy) => policy.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('answers 404 for a backend filter that names nothing', async () => {
    const response = await call('GET', '/policies?backendId=00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404 for an unknown agent filter', async () => {
    const response = await call('GET', '/policies?agentId=00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
  });

  it('filters by agent and effect, keeping total honest', async () => {
    const agent = createTestAgent(store, testKeys(), { name: 'filtered-agent' });
    const policyId = await createPolicy('assigned', [{ resource: 'tool', target: 'x__y', effect: 'deny' }]);

    const before = await json<{ pagination: Record<string, number> }>(await call('GET', `/policies?agentId=${agent.id}`));
    expect(before.pagination.total).toBe(0);

    await call('POST', `/policies/${policyId}/assignments`, { agentId: agent.id });

    const after = await json<{ data: Array<{ id: string }>; pagination: Record<string, number> }>(
      await call('GET', `/policies?agentId=${agent.id}`),
    );
    expect(after.pagination.total).toBe(1);
    expect(after.data[0]!.id).toBe(policyId);

    const deny = await json<{ pagination: Record<string, number> }>(await call('GET', '/policies?effect=deny'));
    expect(deny.pagination.total).toBe(1);

    const allow = await json<{ pagination: Record<string, number> }>(await call('GET', '/policies?effect=allow'));
    expect(allow.pagination.total).toBe(0);
  });
});

describe('effective access', () => {
  it('previews default-deny with no policy assigned', async () => {
    const agent = createTestAgent(store, testKeys(), { name: 'no-policy' });

    const response = await call('GET', `/agents/${agent.id}/access`);
    expect(response.status).toBe(200);

    const { data } = await json<{ data: Record<string, any> }>(response);
    expect(data.agentId).toBe(agent.id);
    expect(data.policies).toEqual([]);
    expect(data.visibleTools).toEqual([]);
  });

  it('never exposes another agent or a credential', async () => {
    const first = createTestAgent(store, testKeys(), { name: 'first' });
    createTestAgent(store, testKeys(), { name: 'second' });

    const raw = JSON.stringify(await json(await call('GET', `/agents/${first.id}/access`)));
    expect(raw).not.toContain(first.authorization.replace('Bearer ', ''));
    expect(raw).not.toContain('credentialId');
    expect(raw).not.toContain('test-only-credential-secret');
  });

  it('is 404 for an unknown agent', async () => {
    const response = await call('GET', '/agents/00000000-0000-4000-8000-000000000000/access');
    expect(response.status).toBe(404);
  });
});

describe('policy CRUD', () => {
  it('creates, reads, updates and deletes a policy', async () => {
    const policyId = await createPolicy('lifecycle', []);

    const read = await json<{ data: { name: string; rules: unknown[] } }>(await call('GET', `/policies/${policyId}`));
    expect(read.data).toMatchObject({ name: 'lifecycle', rules: [] });

    const patched = await json<{ data: { priority: number } }>(
      await call('PATCH', `/policies/${policyId}`, { priority: 5 }),
    );
    expect(patched.data.priority).toBe(5);

    const removed = await call('DELETE', `/policies/${policyId}`);
    expect(removed.status).toBe(200);
    expect((await call('GET', `/policies/${policyId}`)).status).toBe(404);
  });

  it('rejects a rule naming a backend that does not exist', async () => {
    const response = await call('POST', '/policies', {
      name: 'bad-target',
      rules: [{ resource: 'backend', target: '00000000-0000-4000-8000-000000000000', effect: 'allow' }],
    });

    expect(response.status).toBe(400);
    expect((await json<{ error: { message: string } }>(response)).error.message).toMatch(/backend that does not exist/i);
  });
});
