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
import { AgentService } from '../src/registry/agent-service.js';
import { CredentialService } from '../src/registry/credential-service.js';
import { buildTools } from '../src/routing/catalog.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';

/**
 * The authentication and authorization boundary over a real socket.
 *
 * These tests exist because the interesting failures are not about the decision
 * function — they are about what a client can *observe*: a 401 shape that
 * differs per failure reason, a session id that carries identity forward, an
 * error that distinguishes "not yours" from "does not exist".
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({
  ENVIRONMENT: 'test',
  LOG_LEVEL: 'silent',
  ALLOW_PRIVATE_NETWORK: 'true',
});
const logger = createLogger(config);

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let directory: string;
let store: Database;
let gateway: Gateway;
let server: ServerType;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gw-mcp-auth-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });

  server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // Host must be loopback: the DNS-rebinding guard runs before authentication.
  url = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A raw JSON-RPC POST, so the response is inspected rather than interpreted. */
async function rpc(headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, response };
}

function joinable(id: string, name: string): string {
  return `${id}__${name}`;
}

async function connect(identity: TestAgent): Promise<Client> {
  const client = new Client({ name: 'client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(identity) } }),
  );
  clients.push(client);
  return client;
}

describe('unauthenticated requests', () => {
  it('answers every failure with one indistinguishable 401', async () => {
    const agent = createTestAgent(store, testKeys(), { name: 'valid' });
    const token = agent.authorization.replace('Bearer ', '');

    const disabled = createTestAgent(store, testKeys(), { name: 'disabled' });
    new AgentService(store).setEnabled(disabled.id, false);
    const revoked = createTestAgent(store, testKeys(), { name: 'revoked' });
    new CredentialService({ store, keys: testKeys() }).revoke(revoked.id, revoked.credentialId);

    const cases: Array<Record<string, string>> = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer umg_live_short' },
      { authorization: `Bearer umg_live_${'A'.repeat(43)}` },
      { authorization: `Bearer ${token.slice(0, -1)}X` },
      { authorization: disabled.authorization },
      { authorization: revoked.authorization },
    ];

    const answers = await Promise.all(cases.map((headers) => rpc(headers)));

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.response.headers.get('www-authenticate')).toMatch(/^Bearer /);
      expect(answer.text).toBe(answers[0]!.text);
    }

    // One JSON-RPC error envelope, no gateway vocabulary (agent, policy, tool).
    expect(JSON.parse(answers[0]!.text)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  });

  it('refuses a replayed session id that arrives without a credential', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });

    const initialized = await rpc(bearer(agent), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    });
    expect(initialized.status).toBe(200);

    // Phase 6 servers are stateless: no session id is issued at all, so there is
    // nothing a client could replay. If that ever changes, the id must still not
    // authenticate: it is a header, not a credential.
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const replayed = await rpc(sessionId === null ? {} : { 'mcp-session-id': sessionId });
    expect(replayed.status).toBe(401);
  });

  it('re-authenticates every request, so revocation takes effect mid-session', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const client = await connect(agent);
    expect((await client.listTools()).tools).toEqual([]);

    new CredentialService({ store, keys: testKeys() }).revoke(agent.id, agent.credentialId);

    await expect(client.listTools()).rejects.toThrow();
    expect(store.audit.list(50).some((event) => event.action === 'auth.failed')).toBe(true);
  });

  it('does not accept a client-supplied agent id as identity', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const other = createTestAgent(store, testKeys(), { name: 'other' });

    // Every plausible place a client might try to declare who it is.
    const spoofed = await rpc({
      ...JSON_HEADERS,
      'x-agent-id': other.id,
      'x-agent-name': other.name,
      ...bearer(agent),
    });

    // The request is still authenticated as *agent*, which is the only identity
    // with a credential; the claim headers are ignored, not trusted.
    expect(spoofed.status).toBe(200);
  });
});

describe('identity scoping', () => {
  it('gives two agents different views of the same catalog', async () => {
    const backend = await new AgentService(store).create({ name: 'backend-a' });
    const { tools } = buildTools({
      backendId: backend.id,
      now: new Date().toISOString(),
      tools: [
        { name: 'echo', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', inputSchema: { type: 'object', properties: {} } },
      ],
      rejected: [],
    });
    gateway.catalog.replace({
      backendId: backend.id,
      tools,
      report: {
        backendId: backend.id,
        status: 'ok',
        toolCount: tools.size,
        conflictCount: 0,
        rejectedCount: 0,
        discoveredAt: new Date().toISOString(),
      },
    });

    const reader = createTestAgent(store, testKeys(), { name: 'reader', allowTools: [joinable(backend.id, 'echo')] });
    const writer = createTestAgent(store, testKeys(), { name: 'writer', allowTools: ['*'] });
    const nobody = createTestAgent(store, testKeys(), { name: 'nobody' });

    expect((await (await connect(reader)).listTools()).tools.map((tool) => tool.name)).toEqual([
      joinable(backend.id, 'echo'),
    ]);
    expect((await (await connect(writer)).listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      joinable(backend.id, 'echo'),
      joinable(backend.id, 'write'),
    ]);
    expect((await (await connect(nobody)).listTools()).tools).toEqual([]);
  });

  it('cannot call a tool another agent may use, and the answer is the unknown-tool answer', async () => {
    const backend = await new AgentService(store).create({ name: 'backend-a' });
    const { tools } = buildTools({
      backendId: backend.id,
      now: new Date().toISOString(),
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      rejected: [],
    });
    gateway.catalog.replace({
      backendId: backend.id,
      tools,
      report: {
        backendId: backend.id,
        status: 'ok',
        toolCount: tools.size,
        conflictCount: 0,
        rejectedCount: 0,
        discoveredAt: new Date().toISOString(),
      },
    });

    const denied = createTestAgent(store, testKeys(), { name: 'denied' });
    const name = joinable(backend.id, 'echo');

    // A hint at the real name is indistinguishable from an invented one.
    const deniedAnswer = await rpc(bearer(denied), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    });
    const ghostAnswer = await rpc(bearer(denied), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ghost__tool', arguments: {} },
    });

    const frame = (text: string) => JSON.parse(text.split('data: ').at(-1) ?? text);
    expect(deniedAnswer.status).toBe(200);
    expect(frame(deniedAnswer.text)).toEqual(frame(ghostAnswer.text));
    expect(frame(deniedAnswer.text)).toMatchObject({ error: { code: -32602, message: 'Unknown tool' } });

    // Nothing was routed: no catalog resolution, no backend lookup, no activity.
    expect(store.activity.count()).toBe(0);
  });

  it('audits a denial with the identity and the real reason, and never on the wire', async () => {
    const backend = await new AgentService(store).create({ name: 'backend-a' });
    const { tools } = buildTools({
      backendId: backend.id,
      now: new Date().toISOString(),
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      rejected: [],
    });
    gateway.catalog.replace({
      backendId: backend.id,
      tools,
      report: {
        backendId: backend.id,
        status: 'ok',
        toolCount: tools.size,
        conflictCount: 0,
        rejectedCount: 0,
        discoveredAt: new Date().toISOString(),
      },
    });

    const denied = createTestAgent(store, testKeys(), { name: 'denied' });
    const name = joinable(backend.id, 'echo');
    await rpc(bearer(denied), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    });

    const event = store.audit.list(50).find((candidate) => candidate.action === 'access.denied')!;
    expect(event).toMatchObject({ actorType: 'agent', actorId: denied.id, result: 'denied' });
    expect(event.metadata).toMatchObject({
      reason: 'default_deny',
      backendId: backend.id,
      toolId: name,
      credentialId: denied.credentialId,
    });
  });
});

describe('a live backend', () => {
  it('lists only the granted tool and refuses the rest without invoking anything', async () => {
    const created = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { ...JSON_HEADERS, host: '127.0.0.1' },
      body: JSON.stringify({
        name: 'backend-a',
        connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, 'a'] },
      }),
    });
    const { data } = (await created.json()) as { data: { id: string } };

    const connected = await gateway.app.request(`/api/v1/backends/${data.id}/connect`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, host: '127.0.0.1' },
    });
    expect(connected.status).toBe(200);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && gateway.catalog.listByBackend(data.id).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const agent = createTestAgent(store, testKeys(), { allowTools: [joinable(data.id, 'echo'), 'ghost__tool'] });
    const client = await connect(agent);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([joinable(data.id, 'echo')]);

    const allowed = await client.callTool({ name: joinable(data.id, 'echo'), arguments: { text: 'hi' } });
    expect((allowed.content[0] as { text: string }).text).toContain('hi');

    // `get_status` exists on the backend but was never granted.
    await expect(client.callTool({ name: joinable(data.id, 'get_status'), arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: 'Unknown tool',
    });

    // Only the allowed call reached routing: the denial produced no tool activity.
    const calls = store.activity.list(50).filter((event) => event.type === 'tools.call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: 'success', toolName: joinable(data.id, 'echo') });
  });
});
