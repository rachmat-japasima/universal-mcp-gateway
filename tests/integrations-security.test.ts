import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import type { ToolDefinition } from '../src/domain/tool.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { buildOpenApi } from '../src/api/openapi.js';
import type { Connector, ConnectorContext } from '../src/integrations/connector.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { integrationConnectionSchema, type IntegrationConnection } from '../src/integrations/connection.js';
import { EnvelopeVault } from '../src/integrations/vault.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { PolicyService } from '../src/registry/policy-service.js';
import { AppError } from '../src/shared/errors.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';
import { testKeys } from './fixtures/auth.js';

/**
 * Security regressions for managed integrations (ADR-049/051).
 *
 * Every assertion here is a negative: the secret never reaches disk, the
 * unconfigured vault refuses rather than degrades, the operator API admits
 * only authenticated operators, and a caller who was never granted the tool
 * never reaches the connector. Nothing asserts features — they pin the
 * boundaries the feature must not cross.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const NOW = '2026-11-22T00:00:00.000Z';
const HOST = { host: '127.0.0.1:8787' };
const PROVIDER_ID = '66666666-6666-4666-8666-666666666666';

let directory: string;
let store: Database;
let gateway: Gateway;
let hadMasterKey: string | undefined;

/**
 * The gateway reads the master key from `process.env` at wiring time, so each
 * test controls it explicitly and restores what it found.
 */
function withMasterKey(key: string | undefined, run: () => void): void {
  const previous = process.env['INTEGRATION_MASTER_KEY'];
  if (key === undefined) delete process.env['INTEGRATION_MASTER_KEY'];
  else process.env['INTEGRATION_MASTER_KEY'] = key;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env['INTEGRATION_MASTER_KEY'];
    else process.env['INTEGRATION_MASTER_KEY'] = previous;
  }
}

/** A connector that records executions: the boundary authorization must not cross. */
function recordingConnector() {
  const executions: Array<{ context: ConnectorContext; toolName: string; args: unknown }> = [];
  const connector: Connector = {
    discoverTools: async () => ({
      ok: true,
      value: [{ name: 'get_status', inputSchema: { type: 'object' } } satisfies ToolDefinition],
    }),
    executeTool: async (context, toolName, args) => {
      executions.push({ context, toolName, args });
      return {
        ok: true,
        value: { content: [{ type: 'text', text: 'fixture' }] } satisfies CallToolResult,
      };
    },
  };
  return { connector, executions };
}

/** A registry holding exactly the fixture provider. */
function fixtureRegistry(connector: Connector): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(
    {
      id: PROVIDER_ID,
      name: 'Fixture Provider',
      description: 'Security-regression fixture; never registered in production.',
      capabilities: ['discovery', 'execution'],
      metadata: {},
    },
    connector,
  );
  return registry;
}

/** Builds a real gateway over a fresh store with the fixture provider wired. */
function buildGateway(registry?: ProviderRegistry): Gateway {
  return createGateway({ config, logger, store, credentialKeys: testKeys(), ...(registry ? { providerRegistry: registry } : {}) });
}

/** One connected fixture connection through the gateway's own integration service. */
async function connectFixture(service: NonNullable<Gateway['integrations']>): Promise<IntegrationConnection> {
  const connection = service.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'sec-fixture', metadata: {} });
  await service.connect(connection.id);
  return connection;
}

/** Every byte of every database file: WAL siblings included. Plaintext has nowhere to hide. */
function allDatabaseBytes(): Buffer[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith('gateway.db'))
    .map((name) => readFileSync(join(directory, name)));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-intsec-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  hadMasterKey = process.env['INTEGRATION_MASTER_KEY'];
  process.env['INTEGRATION_MASTER_KEY'] = randomBytes(32).toString('base64');
});

afterEach(async () => {
  if (hadMasterKey === undefined) delete process.env['INTEGRATION_MASTER_KEY'];
  else process.env['INTEGRATION_MASTER_KEY'] = hadMasterKey;
  await gateway?.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  gateway = undefined!;
});

describe('secrets at rest', () => {
  it('never writes the credential value to any database file, while the envelope row exists', async () => {
    const { connector } = recordingConnector();
    gateway = buildGateway(fixtureRegistry(connector));
    const secret = `fixture-live-token-${randomUUID()}`;

    const connection = await connectFixture(gateway.integrations!);
    gateway.integrations!.storeCredential(connection.id, secret);

    // The negative is meaningful only if the row exists: an envelope is stored.
    const linked = gateway.integrations!.list()[0]!;
    expect(linked.credentialId).toBeTruthy();

    for (const bytes of allDatabaseBytes()) {
      expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    }
  });

  it('records credential events as references only: the audit log cannot quote the value', async () => {
    const { connector } = recordingConnector();
    gateway = buildGateway(fixtureRegistry(connector));
    const secret = `fixture-live-token-${randomUUID()}`;

    const connection = await connectFixture(gateway.integrations!);
    gateway.integrations!.storeCredential(connection.id, secret);
    const credentialId = gateway.integrations!.list()[0]!.credentialId!;
    await gateway.integrations!.resolveCredential(credentialId);

    const audit = store.audit.list(50);
    const relevant = audit.filter((event) => event.action.startsWith('integration.credential.'));
    expect(relevant.map((event) => event.action).sort()).toEqual([
      'integration.credential.resolved',
      'integration.credential.sealed',
    ]);
    for (const event of relevant) {
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(event.metadata).toMatchObject({ credentialId });
    }
  });
});

describe('vault fail-closed behavior', () => {
  it('refuses to seal or unseal without a master key instead of storing weaker material', () => {
    withMasterKey(undefined, () => {
      const vault = new EnvelopeVault();
      expect(vault.configured).toBe(false);

      expect(() => vault.seal('anything')).toThrow(AppError);
      expect(() => vault.unseal('{"v":1}')).toThrow(AppError);
    });
  });

  it('keeps the gateway honest: an unconfigured deployment cannot store a credential at all', () => {
    withMasterKey(undefined, () => {
      gateway = buildGateway(fixtureRegistry(recordingConnector().connector));

      // A connection row that exists but no operator-configured key.
      const row = integrationConnectionSchema.parse({
        id: randomUUID(),
        providerId: PROVIDER_ID,
        name: 'no-vault',
        status: 'pending',
        credentialId: null,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      });
      store.integrationConnections.create(row);

      expect(() => gateway.integrations!.storeCredential(row.id, 'would-be-secret')).toThrow(AppError);
      const written = store.handle.prepare('SELECT COUNT(*) AS n FROM integration_credentials').get() as { n: number };
      expect(written.n).toBe(0);
      // The connection is untouched: no dangling reference was written.
      expect(store.integrationConnections.findById(row.id)?.credentialId).toBeNull();
    });
  });
});

describe('operator API boundary', () => {
  it('admits no unauthenticated caller to either integrations endpoint', async () => {
    gateway = buildGateway();

    for (const path of ['/providers', '/connections']) {
      const response = await gateway.app.request(`/api/v1/integrations${path}`, { headers: HOST });
      expect(response.status, path).toBe(401);
    }
  });

  it('reports the true empty state to an operator: no provider, no connection, no padding', async () => {
    gateway = buildGateway();
    const session = createTestOperator(store, testKeys());

    for (const path of ['/providers', '/connections']) {
      const response = await gateway.app.request(`/api/v1/integrations${path}`, {
        headers: { ...HOST, ...session.headers },
      });
      expect(response.status, path).toBe(200);
      expect(await response.json()).toEqual({ data: [] });
    }
  });

  it('exposes a credential reference, never a value, through the authenticated listing', async () => {
    const { connector } = recordingConnector();
    gateway = buildGateway(fixtureRegistry(connector));
    const secret = `fixture-live-token-${randomUUID()}`;

    const connection = await connectFixture(gateway.integrations!);
    gateway.integrations!.storeCredential(connection.id, secret);

    const session = createTestOperator(store, testKeys());
    const response = await gateway.app.request('/api/v1/integrations/connections', {
      headers: { ...HOST, ...session.headers },
    });
    const body = JSON.stringify(await response.json());

    expect(body).toContain(gateway.integrations!.list()[0]!.credentialId!);
    expect(body).not.toContain(secret);
  });

  it('documents the two read endpoints and no credential-value endpoint', () => {
    const document = buildOpenApi(config);
    const paths = Object.keys(document['paths'] as Record<string, unknown>);

    expect(paths).toContain('/api/v1/integrations/providers');
    expect(paths).toContain('/api/v1/integrations/connections');
    // The integrations surface has no credential endpoint: agent API-key
    // routes elsewhere in the API are a different, pre-existing surface.
    expect(paths.filter((path) => path.startsWith('/api/v1/integrations') && path.includes('credential'))).toEqual([]);
  });
});

describe('authorization precedes dispatch through the production wiring', () => {
  it('lets a granted caller through and records the call; a stranger never reaches the connector', async () => {
    const { connector, executions } = recordingConnector();
    gateway = buildGateway(fixtureRegistry(connector));
    const connection = await connectFixture(gateway.integrations!);

    const agents = new AgentService(store);
    const policies = new PolicyService({ store });
    const reader = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'fixture', rules: [{ resource: 'tool', target: `${connection.id}__get_status`, effect: 'allow' }] });
    policies.assign(reader.id, grant.id);
    const stranger = agents.create({ name: 'stranger' });

    const routed = await gateway.router!.call(`${connection.id}__get_status`, {}, { agent: reader, requestId: 'sec-1' });
    expect(routed.tool.sourceType).toBe('managed_integration');
    expect(executions).toHaveLength(1);

    // No identity: refused before any source is considered.
    await expect(gateway.router!.call(`${connection.id}__get_status`, {})).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });

    // Denied: the unknown-tool answer, and the connector never ran.
    await expect(gateway.router!.call(`${connection.id}__get_status`, {}, { agent: stranger })).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
    expect(executions).toHaveLength(1);

    // One activity row exists — the allowed call — and it names the connection.
    const rows = store.activity.list(50).filter((event) => event.type === 'tools.call');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ connectionId: connection.id, requestId: 'sec-1' });
  });

  it('hands the connector a context that carries no store handle and no credential value', async () => {
    const { connector, executions } = recordingConnector();
    gateway = buildGateway(fixtureRegistry(connector));
    const connection = await connectFixture(gateway.integrations!);
    gateway.integrations!.storeCredential(connection.id, 'fixture-live-token-known');

    const agents = new AgentService(store);
    const policies = new PolicyService({ store });
    const caller = agents.create({ name: 'caller' });
    const grant = policies.create({ name: 'wild', rules: [{ resource: 'tool', target: '*', effect: 'allow' }] });
    policies.assign(caller.id, grant.id);

    await gateway.router!.call(`${connection.id}__get_status`, {}, { agent: caller });

    expect(executions).toHaveLength(1);
    const context = executions[0]!.context;
    expect(Object.keys(context).sort()).toEqual([
      'connectionId',
      'metadata',
      'resolveCredential',
      'signal',
      'timeoutMs',
    ]);
    // A connector may pull the credential through the resolver, but the
    // context never carries the value eagerly.
    expect(JSON.stringify(context)).not.toContain('fixture-live-token-known');
    const credentialId = gateway.integrations!.list()[0]!.credentialId!;
    await expect(context.resolveCredential(credentialId)).resolves.toBe('fixture-live-token-known');
  });
});
