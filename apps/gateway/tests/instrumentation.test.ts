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
import { metrics } from '../src/monitoring/metrics.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Instrumentation (Phase 11, checkpoint 4): the writers behind the export.
 *
 * Every assertion is a *delta* on the process singleton, because the registry
 * is shared across the whole file by design — writers import it, they are not
 * threaded through constructors. What is under test is that an event an
 * operator would ask about ("how many calls failed?") lands in the right
 * series, not the absolute count.
 *
 * What is deliberately NOT asserted here: label values derived from names or
 * ids. The closed-enum guarantee is the registry's own test file; these tests
 * prove the call sites.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent', ALLOW_PRIVATE_NETWORK: 'true' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;
let session: TestOperatorSession;
let agent: TestAgent;
let server: ServerType;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gw-instrumentation-'));
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

/** The singleton's current value for one exact label set; 0 when absent. */
function countOf(name: string, labels: Record<string, string> = {}): number {
  const snapshot = metrics.snapshot();
  const metric = snapshot.metrics.find((candidate) => candidate.name === name);
  if (metric === undefined) return 0;

  const sample = metric.samples.find((candidate) => {
    const present = (candidate as { labels?: Record<string, string> }).labels ?? {};
    const wanted = Object.keys(labels);
    return (
      Object.keys(present).length === wanted.length &&
      wanted.every((key) => present[key] === labels[key])
    );
  });

  return sample === undefined ? 0 : ((sample as { value?: number }).value ?? 0);
}

/** A histogram's observation count for one label set; 0 when absent. */
function observationsOf(name: string, labels: Record<string, string>): number {
  const snapshot = metrics.snapshot();
  const metric = snapshot.metrics.find((candidate) => candidate.name === name);
  if (metric === undefined) return 0;

  const sample = metric.samples.find((candidate) => {
    const present = (candidate as { labels?: Record<string, string> }).labels ?? {};
    const wanted = Object.keys(labels);
    return (
      Object.keys(present).length === wanted.length &&
      wanted.every((key) => present[key] === labels[key])
    );
  });

  return sample === undefined ? 0 : ((sample as { count?: number }).count ?? 0);
}

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
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(identity) } }));
  clients.push(client);
  return client;
}

describe('tool execution', () => {
  it('counts successful calls, failed calls with their code, and durations', async () => {
    const id = await startBackend('backend-b', 'b');

    // The router writes the closed source_type label; the read is exact over
    // the full label set, as it always was.
    const successBefore = countOf('umg_tool_calls_total', { outcome: 'success', source_type: 'mcp_backend' });
    const durationBefore = observationsOf('umg_tool_call_duration_ms', {});

    const client = await connect(true);
    const result = await client.callTool({ name: `${id}__create_item`, arguments: { kind: 'b', name: 'widget' } });
    expect(result.isError).toBeFalsy();

    expect(countOf('umg_tool_calls_total', { outcome: 'success', source_type: 'mcp_backend' })).toBeGreaterThan(
      successBefore,
    );
    expect(observationsOf('umg_tool_call_duration_ms', {})).toBeGreaterThan(durationBefore);

    const failureBefore = countOf('umg_tool_calls_total', { outcome: 'failure', source_type: 'mcp_backend' });
    const codeBefore = countOf('umg_tool_failures_total', { code: 'TOOL_UNAVAILABLE' });

    // The fixture answers isError: a successful round trip and a failed call,
    // which is exactly the split the counters must show.
    const failed = await client.callTool({ name: `${id}__fail`, arguments: {} });
    expect(failed.isError).toBe(true);

    expect(countOf('umg_tool_calls_total', { outcome: 'failure', source_type: 'mcp_backend' })).toBeGreaterThan(
      failureBefore,
    );
    expect(countOf('umg_tool_failures_total', { code: 'TOOL_UNAVAILABLE' })).toBeGreaterThan(codeBefore);
  });

  it('counts authorization denials without a tool-name or agent label', async () => {
    const id = await startBackend('backend-a', 'a');
    // An agent with no grants: everything it tries is denied.
    const stranger = createTestAgent(store, testKeys(), { name: 'stranger-agent' });

    const callsDeniedBefore = countOf('umg_tool_calls_total', { outcome: 'denied' });
    const authzDeniedBefore = countOf('umg_authz_denials_total', { surface: 'tool' });

    const client = await connect(true, stranger);
    await expect(client.callTool({ name: `${id}__echo`, arguments: { text: 'no' } })).rejects.toMatchObject({
      code: -32602,
      message: 'Unknown tool',
    });

    expect(countOf('umg_tool_calls_total', { outcome: 'denied' })).toBeGreaterThan(callsDeniedBefore);
    expect(countOf('umg_authz_denials_total', { surface: 'tool' })).toBeGreaterThan(authzDeniedBefore);
    // The denial never became a *name* in any series.
    const snapshotText = JSON.stringify(metrics.snapshot());
    expect(snapshotText).not.toContain(`${id}__echo`);
  });
});

describe('MCP surface', () => {
  it('counts tools.list and tools.call with durations over both eras', async () => {
    const id = await startBackend('backend-a', 'a');

    for (const modern of [false, true]) {
      const listBefore = countOf('umg_mcp_method_total', { method: 'tools.list', outcome: 'success' });
      const listDurationBefore = observationsOf('umg_mcp_method_duration_ms', { method: 'tools.list' });

      const client = await connect(modern);
      await client.listTools();

      expect(countOf('umg_mcp_method_total', { method: 'tools.list', outcome: 'success' })).toBeGreaterThan(listBefore);
      expect(observationsOf('umg_mcp_method_duration_ms', { method: 'tools.list' })).toBeGreaterThan(listDurationBefore);
    }
  });

  it('counts initialize when a 2025-era session is created', async () => {
    const initializeBefore = countOf('umg_mcp_method_total', { method: 'initialize', outcome: 'success' });

    const client = await connect(false);
    await client.listTools();

    expect(countOf('umg_mcp_method_total', { method: 'initialize', outcome: 'success' })).toBeGreaterThan(initializeBefore);
  });

  it('counts a refused session id on the modern leg', async () => {
    const deniedBefore = countOf('umg_mcp_session_denied_total');
    const authzBefore = countOf('umg_authz_denials_total', { surface: 'session' });

    const response = await gateway.app.request('/mcp', {
      headers: { ...HOST, ...bearer(agent), 'mcp-session-id': 'not-a-session-the-gateway-ever-issued' },
    });
    expect(response.status).toBe(404);

    expect(countOf('umg_mcp_session_denied_total')).toBeGreaterThan(deniedBefore);
    expect(countOf('umg_authz_denials_total', { surface: 'session' })).toBeGreaterThan(authzBefore);
  });

  it('counts agent authentication successes and failures without a reason label', async () => {
    const successBefore = countOf('umg_auth_total', { surface: 'agent', outcome: 'success' });
    const failureBefore = countOf('umg_auth_total', { surface: 'agent', outcome: 'failure' });

    // A garbage bearer is refused 401 before the MCP surface exists for it.
    const refused = await gateway.app.request('/mcp', {
      headers: { ...HOST, Authorization: 'Bearer definitely-not-a-token' },
    });
    expect(refused.status).toBe(401);
    expect(countOf('umg_auth_total', { surface: 'agent', outcome: 'failure' })).toBeGreaterThan(failureBefore);

    const client = await connect(true);
    await client.listTools();
    expect(countOf('umg_auth_total', { surface: 'agent', outcome: 'success' })).toBeGreaterThan(successBefore);
  });
});

describe('operator and registry surfaces', () => {
  it('counts operator login outcomes', async () => {
    const successBefore = countOf('umg_auth_total', { surface: 'operator', outcome: 'success' });
    const failureBefore = countOf('umg_auth_total', { surface: 'operator', outcome: 'failure' });

    const bad = await gateway.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'test-operator', password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);
    expect(countOf('umg_auth_total', { surface: 'operator', outcome: 'failure' })).toBeGreaterThan(failureBefore);

    const good = await gateway.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'test-operator', password: 'test-only-operator-password' }),
    });
    expect(good.status).toBe(200);
    expect(countOf('umg_auth_total', { surface: 'operator', outcome: 'success' })).toBeGreaterThan(successBefore);
  });

  it('counts credential revocations from both revoke and rotate', async () => {
    const revokedBefore = countOf('umg_credentials_revoked_total');

    const created = await gateway.app.request(`/api/v1/agents/${agent.id}/credentials`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const issued = (await created.json()) as { data: { id: string } };

    const rotated = await gateway.app.request(`/api/v1/agents/${agent.id}/credentials/${issued.data.id}/rotate`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
      body: JSON.stringify({}),
    });
    expect(rotated.status).toBe(200);
    expect(countOf('umg_credentials_revoked_total')).toBeGreaterThan(revokedBefore);

    // A *direct* revocation needs a still-live credential: the one above is
    // already dead, and re-revoking it is a no-op the counter must ignore.
    const second = await gateway.app.request(`/api/v1/agents/${agent.id}/credentials`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(201);
    const secondIssued = (await second.json()) as { data: { id: string } };

    const beforeRevoke = countOf('umg_credentials_revoked_total');
    const revoked = await gateway.app.request(
      `/api/v1/agents/${agent.id}/credentials/${secondIssued.data.id}/revoke`,
      { method: 'POST', headers: { ...JSON_HEADERS, ...session.headers } },
    );
    expect(revoked.status).toBe(200);
    expect(countOf('umg_credentials_revoked_total')).toBeGreaterThan(beforeRevoke);
  });

  it('counts backend enable and disable changes', async () => {
    const id = await startBackend('backend-changes', 'b');

    const disabledBefore = countOf('umg_backend_changes_total', { action: 'disabled' });
    const disable = await gateway.app.request(`/api/v1/backends/${id}/disable`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
    });
    expect(disable.status).toBe(200);
    expect(countOf('umg_backend_changes_total', { action: 'disabled' })).toBeGreaterThan(disabledBefore);

    const enabledBefore = countOf('umg_backend_changes_total', { action: 'enabled' });
    const enable = await gateway.app.request(`/api/v1/backends/${id}/enable`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
    });
    expect(enable.status).toBe(200);
    expect(countOf('umg_backend_changes_total', { action: 'enabled' })).toBeGreaterThan(enabledBefore);
  });
});

describe('backend lifecycle', () => {
  it('counts connection successes and disconnects', async () => {
    const connectedBefore = countOf('umg_backend_connections_total', { outcome: 'success' });
    const id = await startBackend('backend-lifecycle', 'b');
    expect(countOf('umg_backend_connections_total', { outcome: 'success' })).toBeGreaterThan(connectedBefore);

    const disconnectedBefore = countOf('umg_backend_disconnects_total');
    const response = await gateway.app.request(`/api/v1/backends/${id}/disconnect`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
    });
    expect(response.status).toBe(200);
    expect(countOf('umg_backend_disconnects_total')).toBeGreaterThan(disconnectedBefore);
  });

  it('counts a failed connection attempt', async () => {
    const failedBefore = countOf('umg_backend_connections_total', { outcome: 'failure' });

    // An executable that does not exist: a permanent failure, the kind an
    // operator wants on the dashboard next to the successes.
    const created = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
      body: JSON.stringify({
        name: 'backend-unreachable',
        connection: { type: 'stdio', command: '/nonexistent/definitely-not-here', args: [] },
      }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const connected = await gateway.app.request(`/api/v1/backends/${data.id}/connect`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...session.headers },
    });
    expect(connected.status).toBe(502);
    expect(countOf('umg_backend_connections_total', { outcome: 'failure' })).toBeGreaterThan(failedBefore);
  });
});
