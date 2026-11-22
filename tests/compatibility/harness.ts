import { serve, type ServerType } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../../src/config/config.js';
import { createGateway, type Gateway } from '../../src/core/gateway.js';
import { CredentialService } from '../../src/registry/credential-service.js';
import { createLogger } from '../../src/monitoring/logger.js';
import { openStore, type Database } from '../../src/infrastructure/database/index.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from '../fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from '../fixtures/operator.js';

/**
 * Phase 14 compatibility harness.
 *
 * One gateway on one real loopback socket, driven the way a real MCP client
 * drives it: the official SDK `Client` over `StreamableHTTPClientTransport`
 * for everything the protocol can express, raw `fetch` for the wire-level
 * facts a client cannot say through the SDK (a missing header, a foreign
 * session id, a DELETE). No agent-specific code lives here — the "client" is
 * the SDK, which is the same client library Claude Code, Codex and OpenCode
 * embed in some version. A client harness that imported a specific agent would
 * answer a different question than the one this phase asks.
 *
 * The stdio backend fixtures (`tests/fixtures/catalog-fixture.ts`) are real
 * subprocesses, so discovery, schema forwarding and execution cross the real
 * transport, not a stub. Nothing here is reachable from production
 * configuration: the store is a temp directory and the socket is loopback.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/catalog-fixture.ts', import.meta.url));

export const JSON_HEADERS = {
  host: '127.0.0.1:8787',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;

export interface Harness {
  store: Database;
  gateway: Gateway;
  /** Operator session: registering a backend goes through the management API. */
  operator: TestOperatorSession;
  url: string;
  config: Config;
  keys: ReturnType<typeof testKeys>;

  agent(options?: { allowTools?: string[]; denyTools?: string[]; name?: string }): TestAgent;
  /** Registers and connects one stdio fixture backend, waits for discovery. */
  backend(name: string, mode: string): Promise<string>;
  /** A connected SDK client, tracked for teardown. */
  client(agent: TestAgent, modern?: boolean): Promise<Client>;
  /** Raw JSON-RPC over the wire; the one road for facts the SDK cannot say. */
  rpc(headers: Record<string, string>, body: unknown, init?: RequestInit): Promise<{ status: number; sessionId: string | null; text: string }>;
  until(predicate: () => boolean, label?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots one harness. `env` overrides reach `loadConfig` verbatim, so a file
 * can ask for a short tool-call budget (floors apply; e.g. session idle
 * timeout cannot go below 60 s) without touching any other file's defaults.
 */
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'silent',
    ALLOW_PRIVATE_NETWORK: 'true',
    SESSION_IDLE_TIMEOUT_MS: '60000',
    ...env,
  });
  const logger = createLogger(config);
  const keys = testKeys();

  const directory = mkdtempSync(join(tmpdir(), 'gw-compat-'));
  const store = openStore({ path: join(directory, 'gateway.db') });
  const gateway = createGateway({ config, logger, store, credentialKeys: keys });
  const operator = createTestOperator(store, keys);

  const server = serve({ fetch: gateway.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;

  const clients: Client[] = [];

  async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const harness: Harness = {
    store,
    gateway,
    operator,
    url,
    config,
    keys,

    agent(options = {}) {
      return createTestAgent(store, keys, options);
    },

    async backend(name, mode) {
      const created = await gateway.app.request('/api/v1/backends', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json', ...operator.headers },
        body: JSON.stringify({
          name,
          connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE, mode] },
        }),
      });
      if (created.status !== 201) throw new Error(`backend create failed: ${created.status} ${await created.text()}`);
      const { data } = (await created.json()) as { data: { id: string } };

      const connected = await gateway.app.request(`/api/v1/backends/${data.id}/connect`, {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json', ...operator.headers },
      });
      if (connected.status !== 200) throw new Error(`backend connect failed: ${connected.status}`);

      await until(() => gateway.catalog.listByBackend(data.id).length > 0, `discovery of ${name}`);
      return data.id;
    },

    client(identity, modern = false) {
      const client = new Client(
        { name: 'compatibility-harness', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: 'auto' } } : undefined,
      );
      return client
        .connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(identity) } }))
        .then(() => {
          clients.push(client);
          return client;
        });
    },

    async rpc(headers, body, init = {}) {
      const response = await fetch(url, {
        ...init,
        method: 'POST',
        headers: { ...JSON_HEADERS, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return {
        status: response.status,
        sessionId: response.headers.get('mcp-session-id'),
        text: await response.text(),
      };
    },

    until,

    async close() {
      await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };

  return harness;
}

/** The public names one agent's `tools/list` exposes, for building another agent's exact grant. */
export async function visibleTools(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

/** Issues a credential with an explicit expiry, for the expired-credential scenario. */
export function expiredCredential(harness: Harness, agentId: string): { token: string; id: string } {
  const { credential, token } = new CredentialService({ store: harness.store, keys: harness.keys }).issue(agentId, {
    name: 'expired',
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
  return { token, id: credential.id };
}

/** Revokes an agent's credential exactly the way the operator API does. */
export function revokeCredential(harness: Harness, agent: TestAgent): void {
  new CredentialService({ store: harness.store, keys: harness.keys, sessions: harness.gateway.sessions }).revoke(
    agent.id,
    agent.credentialId,
  );
}

/** A minimal legacy initialize body, pinned to the SDK's latest supported version. */
export const initializeBody = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'compatibility-harness', version: '1.0.0' },
  },
};

/** The SDK-expected follow-up notification. Duplicates must be harmless, not fatal. */
export const initializedNotification = {
  jsonrpc: '2.0' as const,
  method: 'notifications/initialized',
};
