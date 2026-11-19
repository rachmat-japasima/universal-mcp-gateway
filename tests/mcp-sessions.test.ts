import { serve, type ServerType } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { CredentialService } from '../src/registry/credential-service.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Phase 7 over a real socket: the MCP session lifecycle as a client observes it.
 *
 * These tests are about what the SDK and the HTTP surface actually do — which
 * era issues a session id, what a mismatched owner sees, whether a revocation
 * takes effect mid-session — rather than about the decision functions, which are
 * covered in `sessions.test.ts`.
 */

const config = loadConfig({
  ENVIRONMENT: 'test',
  LOG_LEVEL: 'silent',
  SESSION_IDLE_TIMEOUT_MS: '60000',
});

const logger = createLogger(config);
const keys = testKeys();
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let directory: string;
let store: Database;
let gateway: Gateway;
/** Operator session: the management API rejects anonymous callers (Phase 10.0). */
let session: TestOperatorSession;
let server: ServerType;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gw-session-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: keys });
  session = createTestOperator(store, keys);

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

async function rpc(headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), text: await response.text() };
}

const initializeBody = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

function connect(identity: TestAgent, modern: boolean = false): Promise<Client> {
  const client = new Client({ name: 'client', version: '1' }, modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
  return client
    .connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(identity) } }))
    .then(() => {
      clients.push(client);
      return client;
    });
}

function activeSessions(): number {
  return store.sessions.countByStatus('active');
}

describe('initialization and binding', () => {
  it('persists a binding on initialize, with the authenticating agent and credential', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });

    const initialized = await rpc(bearer(agent), initializeBody);
    expect(initialized.status).toBe(200);
    expect(initialized.sessionId).toBeTruthy();

    const bound = store.sessions.findByMcpSessionId(initialized.sessionId!)!;
    expect(bound).toMatchObject({
      agentId: agent.id,
      credentialId: agent.credentialId,
      status: 'active',
    });
    // The internal id is separate from the protocol id and never equals it.
    expect(bound.id).not.toBe(initialized.sessionId);
    expect(bound.expiresAt).toBeTruthy();

    // The protocol id never appears in the management payload as the record id.
    // The operator cookie is the fixture's; the MCP session id is irrelevant to
    // the management API, which is exactly the boundary this asserts.
    const listed = await gateway.app.request('/api/v1/sessions', {
      headers: { host: '127.0.0.1', ...session.headers },
    });
    const body = (await listed.json()) as { data: Array<{ id: string; mcpSessionId?: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(bound.id);
    expect(body.data[0]!.mcpSessionId).toBe(initialized.sessionId);
  });

  it('serves a session-bearing request from the bound transport', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const client = await connect(agent);

    // The SDK client carries the id forward; the gateway routes it to the same
    // transport and re-validates the binding on each exchange.
    expect((await client.listTools()).tools).toEqual([]);
    expect((await client.listTools()).tools).toEqual([]);
    expect(activeSessions()).toBe(1);
  });

  it('keeps sessionless one-shot requests working (Phase 1–6 behaviour)', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });

    const answer = await rpc(bearer(agent), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(answer.status).toBe(200);
    expect(answer.sessionId).toBeNull();
    // Nothing was bound: a client that did not initialize has no session.
    expect(store.sessions.count()).toBe(0);
  });

  it('issues no session id on the 2026 era, which has no protocol session', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const client = await connect(agent, true);

    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await client.listTools()).tools).toEqual([]);
    // Per-request serving: identity is re-established every exchange and there is
    // no session row to bind, which is the SDK's design for that era.
    expect(store.sessions.count()).toBe(0);
  });
});

describe('ownership isolation', () => {
  it('refuses another agent using a valid session id, without revealing ownership', async () => {
    const owner = createTestAgent(store, keys, { name: 'owner', allowTools: ['*'] });
    const intruder = createTestAgent(store, keys, { name: 'intruder', allowTools: ['*'] });

    const initialized = await rpc(bearer(owner), initializeBody);
    const sessionId = initialized.sessionId!;

    const crossAgent = await rpc({ ...bearer(intruder), 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const unknown = await rpc({ ...bearer(intruder), 'mcp-session-id': 'never-issued' }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(crossAgent.status).toBe(404);
    // Indistinguishable from a session id that never existed.
    expect(crossAgent.text).toBe(unknown.text);
    expect(crossAgent.text).not.toContain(owner.id);

    // The owner's session is untouched by the attempt.
    const session = store.sessions.findByMcpSessionId(sessionId)!;
    expect(session.status).toBe('active');
    expect(session.agentId).toBe(owner.id);
  });

  it('refuses a session id with no credential at all', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);

    const replayed = await rpc({ 'mcp-session-id': initialized.sessionId! }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(replayed.status).toBe(401);
  });

  it('cannot be claimed by editing the identity headers', async () => {
    const agent = createTestAgent(store, keys, { name: 'agent', allowTools: ['*'] });
    const other = createTestAgent(store, keys, { name: 'other', allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);

    const spoofed = await rpc(
      {
        ...bearer(agent),
        'x-agent-id': other.id,
        'mcp-session-id': initialized.sessionId!,
      },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    );

    expect(spoofed.status).toBe(200);
    // Identity came from the bearer credential; the header changed nothing.
    expect(store.sessions.findByMcpSessionId(initialized.sessionId!)!.agentId).toBe(agent.id);
  });
});

describe('credential and agent lifecycle', () => {
  it('stops a live session when its credential is revoked', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const client = await connect(agent);
    expect((await client.listTools()).tools).toEqual([]);

    new CredentialService({ store, keys, sessions: gateway.sessions }).revoke(agent.id, agent.credentialId);

    await expect(client.listTools()).rejects.toThrow();
    expect(store.sessions.findById(store.sessions.listByAgentId(agent.id)[0]!.id)!.status).toBe('invalidated');
  });

  it('stops a live session when the agent is disabled', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const client = await connect(agent);
    await client.listTools();

    new AgentService(store, undefined, undefined, gateway.sessions).setEnabled(agent.id, false);

    await expect(client.listTools()).rejects.toThrow();
    expect(store.sessions.listByAgentId(agent.id)[0]!.status).toBe('invalidated');
  });

  it('invalidates the old credential’s sessions on rotation', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const client = await connect(agent);
    await client.listTools();

    const rotated = new CredentialService({ store, keys, sessions: gateway.sessions }).rotate(
      agent.id,
      agent.credentialId,
      {},
    );

    expect(store.sessions.listByAgentId(agent.id)[0]!.terminationReason).toBe('credential_rotated');
    expect(rotated.token).toBeTruthy();

    // The old bearer is dead too, so the request fails at authentication.
    await expect(client.listTools()).rejects.toThrow();
  });

  it('refuses a session whose credential expired without needing the sweep', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);
    const sessionId = initialized.sessionId!;

    // Expire the credential directly: the session row is still `active`, so the
    // request-time check is the only thing that can refuse it.
    store.handle
      .prepare('UPDATE agent_credentials SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), agent.credentialId);

    const answer = await rpc({ ...bearer(agent), 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    // Authentication refuses first: the credential is expired.
    expect(answer.status).toBe(401);
  });
});

describe('termination', () => {
  it('blocks subsequent calls, and a repeat terminate is idempotent', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);
    const sessionId = initialized.sessionId!;
    const internalId = store.sessions.findByMcpSessionId(sessionId)!.id;

    const first = await gateway.app.request(`/api/v1/sessions/${internalId}/terminate`, {
      method: 'POST',
      headers: { host: '127.0.0.1', ...session.headers },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { status: string; terminatedAt: string } };
    expect(firstBody.data.status).toBe('terminated');

    const second = await gateway.app.request(`/api/v1/sessions/${internalId}/terminate`, {
      method: 'POST',
      headers: { host: '127.0.0.1', ...session.headers },
    });
    const secondBody = (await second.json()) as { data: { status: string; terminatedAt: string } };
    expect(secondBody.data).toEqual(firstBody.data);

    const blocked = await rpc({ ...bearer(agent), 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(blocked.status).toBe(404);
  });

  it('terminates every live session on graceful shutdown', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);
    expect(activeSessions()).toBe(1);

    await gateway.close();

    const session = store.sessions.findByMcpSessionId(initialized.sessionId!)!;
    expect(session.status).toBe('terminated');
    expect(session.terminationReason).toBe('gateway_shutdown');
  });
});

describe('expiry without cleanup', () => {
  it('refuses an idle-expired session before the sweep has run', async () => {
    const agent = createTestAgent(store, keys, { allowTools: ['*'] });
    const initialized = await rpc(bearer(agent), initializeBody);
    const sessionId = initialized.sessionId!;

    // Move the activity clock past the 60 s idle timeout from the test config.
    store.handle
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE mcp_session_id = ?')
      .run(new Date(Date.now() - 120_000).toISOString(), sessionId);

    const answer = await rpc({ ...bearer(agent), 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(answer.status).toBe(404);
    // Still `active` in storage: enforcement did not depend on the sweep.
    expect(store.sessions.findByMcpSessionId(sessionId)!.status).toBe('active');
  });
});
