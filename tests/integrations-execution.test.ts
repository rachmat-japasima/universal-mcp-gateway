import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackendLifecycleManager, type ReconnectPolicy } from '../src/adapters/lifecycle.js';
import { AuthorizationService } from '../src/auth/authorization.js';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config/config.js';
import type { ToolDefinition } from '../src/domain/tool.js';
import type { Policy } from '../src/domain/policy.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { PolicyService } from '../src/registry/policy-service.js';
import { ToolCatalog, buildIntegrationTools } from '../src/routing/catalog.js';
import { ToolRouter } from '../src/routing/router.js';
import type { Connector, ConnectorContext, ConnectorError } from '../src/integrations/connector.js';
import { IntegrationService } from '../src/integrations/service.js';
import type { IntegrationConnection } from '../src/integrations/connection.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';
import { AppError } from '../src/shared/errors.js';

/**
 * The managed-integration execution path, end to end through the *real* seam
 * (ADR-049): a fixture connector behind a fixture provider, dispatched by the
 * production `IntegrationService` and the production `ToolRouter`. Nothing here
 * talks to a network, and nothing here is reachable from production
 * configuration: the registry is a per-test instance.
 *
 * The rule the whole file stands on: authorization happens once, in `call()`,
 * before the source seam — so a managed call is authorized exactly like an
 * MCP call, and the connector runs only after that.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const NOW = '2026-11-22T00:00:00.000Z';

const PROVIDER_ID = '44444444-4444-4444-8444-444444444444';

const reconnectOff: ReconnectPolicy = {
  enabled: false,
  initialDelayMs: 100,
  maxDelayMs: 200,
  maxAttempts: 2,
  jitterRatio: 0,
};

/** One connector-reported tool with a plain schema. */
const def = (name: string, inputSchema: Record<string, unknown> = { type: 'object' }): ToolDefinition => ({
  name,
  inputSchema,
});

/**
 * The fixture connector: an in-memory provider. It records every execution so
 * tests can assert what the connector actually received — including what it
 * must NOT have received (a store handle, a credential value).
 */
function fixtureConnector(behavior: {
  tools?: ToolDefinition[];
  result?: (toolName: string, args: unknown) => CallToolResult;
  error?: ConnectorError;
  delayMs?: number;
  failDiscovery?: boolean;
} = {}) {
  const executions: Array<{ context: ConnectorContext; toolName: string; args: unknown }> = [];
  const resolutions: string[] = [];

  const connector: Connector = {
    discoverTools: async () =>
      behavior.failDiscovery === true
        ? { ok: false, error: { kind: 'unreachable', message: 'fixture provider is down' } }
        : { ok: true, value: behavior.tools ?? [def('get_status'), def('run_job')] },

    executeTool: async (context, toolName, args) => {
      executions.push({ context, toolName, args });
      if (behavior.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      if (behavior.error !== undefined) return { ok: false, error: behavior.error };
      return {
        ok: true,
        value: behavior.result?.(toolName, args) ?? {
          content: [{ type: 'text', text: JSON.stringify({ tool: toolName, args }) }],
        },
      };
    },
  };

  /** The resolver handed in by the service, as the connector would call it. */
  const resolverOf = (execution: { context: ConnectorContext }) => execution.context.resolveCredential;

  return { connector, executions, resolutions, resolverOf };
}

interface Harness {
  store: Database;
  catalog: ToolCatalog;
  registry: ProviderRegistry;
  integrations: IntegrationService;
  authorization: AuthorizationService;
  router: ToolRouter;
  connector: ReturnType<typeof fixtureConnector>;
  agents: AgentService;
  policies: PolicyService;
  /** Creates a connection and drives it to `connected` through the connector. */
  connect(name?: string): Promise<IntegrationConnection>;
}

let directory: string;
let store: Database;
let lifecycle: BackendLifecycleManager;

function harness(overrides: { connector?: ReturnType<typeof fixtureConnector>; timeoutMs?: number } = {}): Harness {
  const catalog = new ToolCatalog();
  const registry = new ProviderRegistry();
  const connector = overrides.connector ?? fixtureConnector();
  registry.register(
    {
      id: PROVIDER_ID,
      name: 'Fixture Provider',
      description: 'Throwaway provider for the execution tests.',
      capabilities: ['discovery', 'execution'],
      metadata: {},
    },
    connector.connector,
  );

  const vault = new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') }));
  const integrations = new IntegrationService({
    store,
    registry,
    vault,
    catalog,
    logger,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    now: () => NOW,
  });

  const authorization = new AuthorizationService({ store, catalog, logger, now: () => NOW });
  const router = new ToolRouter({
    store,
    logger,
    lifecycle,
    catalog,
    authorization,
    integrations,
    timeoutMs: 5_000,
  });

  const agents = new AgentService(store);
  const policies = new PolicyService({ store });

  return {
    store,
    catalog,
    registry,
    integrations,
    authorization,
    router,
    connector,
    agents,
    policies,
    /** Creates a connection and drives it to `connected` through the connector. */
    async connect(name = 'fixture-connection') {
      const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name, metadata: {} });
      await integrations.connect(connection.id);
      return connection;
    },
  };
}

const allow = (target: string, resource: 'tool' | 'backend' = 'tool') =>
  ({ resource, target, effect: 'allow' as const }) satisfies Policy['rules'][number];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-int-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  lifecycle = new BackendLifecycleManager({
    store,
    logger,
    networkPolicy: { allowPrivateNetwork: true },
    reconnect: reconnectOff,
    random: () => 0.5,
  });
});

afterEach(async () => {
  await lifecycle.shutdown();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const activity = () => store.activity.list(50).filter((event) => event.type === 'tools.call');
const auditActions = () => store.audit.list(50).map((event) => event.action);

describe('connection lifecycle', () => {
  it('creates a connection as pending and audits the creation', () => {
    const { integrations } = harness();
    const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'ops-org', metadata: {} });

    expect(connection).toMatchObject({ providerId: PROVIDER_ID, status: 'pending', credentialId: null });
    expect(auditActions()).toContain('integration.connection.created');
  });

  it('refuses a connection for a provider that is not registered', () => {
    const { integrations } = harness();

    expect(() =>
      integrations.create({ id: randomUUID(), providerId: randomUUID(), name: 'ghost', metadata: {} }),
    ).toThrow(AppError);
  });

  it('connects through the connector: status flips and tools enter the catalog namespaced', async () => {
    const { integrations, catalog } = harness();
    const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'ops', metadata: {} });

    const { connection: connected } = await integrations.connect(connection.id);

    expect(connected.status).toBe('connected');
    const names = catalog.listAll().map((tool) => tool.publicName);
    expect(names).toEqual([
      `${connection.id}__get_status`,
      `${connection.id}__run_job`,
    ]);
    const tool = catalog.resolve(`${connection.id}__get_status`);
    expect('tool' in tool && tool.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: connection.id });
    // Discovery reports are an MCP surface; a managed source has none.
    expect(catalog.reports()).toEqual([]);
  });

  it('records a failed connect as `error`, keeps the previous catalog empty, and says why', async () => {
    const failing = fixtureConnector({ failDiscovery: true });
    const { integrations, catalog } = harness({ connector: failing });

    const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'ops', metadata: {} });

    await expect(integrations.connect(connection.id)).rejects.toMatchObject({
      code: 'BACKEND_CONNECTION_ERROR',
      details: { connectorMessage: 'fixture provider is down' },
    });

    expect(integrations.list()[0]?.status).toBe('error');
    expect(catalog.listAll()).toEqual([]);
  });

  it('refuses to connect a provider that declares no discovery', async () => {
    const listOnly: Connector = { executeTool: async () => ({ ok: true, value: { content: [] } }) };
    const registry = new ProviderRegistry();
    registry.register(
      {
        id: PROVIDER_ID,
        name: 'List-less',
        description: 'Registers execution without discovery.',
        capabilities: ['execution'],
        metadata: {},
      },
      listOnly,
    );

    const integrations = new IntegrationService({
      store,
      registry,
      vault: new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') })),
      catalog: new ToolCatalog(),
      logger,
      now: () => NOW,
    });

    const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'x', metadata: {} });
    await expect(integrations.connect(connection.id)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('withdraws tools the instant a connection is disconnected or disabled', async () => {
    const { integrations, catalog, connect } = harness();
    const connection = await connect();

    const disconnected = integrations.disconnect(connection.id);
    expect(disconnected.status).toBe('disconnected');
    expect(catalog.listAll()).toEqual([]);

    // A disconnected connection may reconnect; the catalog refills.
    await integrations.connect(connection.id);
    expect(catalog.listAll().length).toBe(2);

    // `connected → disabled` is a legal operator action, and it withdraws
    // the tools in the same instant.
    const disabled = integrations.disable(connection.id);
    expect(disabled.status).toBe('disabled');
    expect(catalog.listAll()).toEqual([]);
    // And `disabled` is terminal: no re-enable edge exists in Phase 12.
    await expect(integrations.connect(connection.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('deletes a connection, its tools, and its cascaded credential rows together', async () => {
    const { integrations, catalog, connect } = harness();
    const connection = await connect();

    integrations.storeCredential(connection.id, 'fixture-secret-value');
    const credentialId = integrations.list()[0]!.credentialId!;

    integrations.remove(connection.id);

    expect(integrations.list()).toEqual([]);
    expect(catalog.listAll()).toEqual([]);
    // The cascade is structural (migration 0008): no orphaned secret row.
    expect(store.integrationCredentials.findById(credentialId)).toBeUndefined();
    expect(auditActions()).toContain('integration.connection.deleted');
  });

  it('rejects an illegal transition instead of repairing it', () => {
    const { integrations } = harness();
    const connection = integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name: 'x', metadata: {} });

    // `pending` has no edge to `disconnected`.
    expect(() => integrations.disconnect(connection.id)).toThrow(AppError);
    expect(integrations.list()[0]?.status).toBe('pending');
  });

  it('supports several connections of one provider without cross-talk', async () => {
    const { integrations, catalog, connect } = harness();
    const first = await connect('first');
    const second = await connect('second');

    const expected = [
      `${first.id}__get_status`,
      `${first.id}__run_job`,
      `${second.id}__get_status`,
      `${second.id}__run_job`,
    ].sort();
    expect(catalog.listAll().map((tool) => tool.publicName).sort()).toEqual(expected);

    integrations.remove(first.id);
    expect(catalog.listAll().map((tool) => tool.sourceId)).toEqual([second.id, second.id]);
  });
});

describe('credentials', () => {
  it('seals a value into the vault and links only a reference to the connection', async () => {
    const { integrations, connect } = harness();
    const connection = await connect();

    integrations.storeCredential(connection.id, 'fixture-secret-value');

    const linked = integrations.list()[0]!;
    expect(linked.credentialId).toBeTruthy();
    // The persisted row carries an envelope only.
    const record = store.integrationCredentials.findById(linked.credentialId!)!;
    expect(record.envelope).not.toContain('fixture-secret-value');
    expect(auditActions()).toContain('integration.credential.sealed');
  });

  it('resolves a reference to its value and audits the resolution without the value', async () => {
    const { integrations, connect } = harness();
    const connection = await connect();
    integrations.storeCredential(connection.id, 'fixture-secret-value');
    const credentialId = integrations.list()[0]!.credentialId!;

    const resolved = await integrations.resolveCredential(credentialId);
    expect(resolved).toBe('fixture-secret-value');

    const rows = store.audit.list(10).filter((event) => event.action === 'integration.credential.resolved');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('fixture-secret-value');
    expect(rows[0]?.metadata).toMatchObject({ credentialId });
  });

  it('fails closed on a dangling credential reference', async () => {
    const { integrations } = harness();

    await expect(integrations.resolveCredential(randomUUID())).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('the router seam', () => {
  it('authorizes before it dispatches, and a denied caller never reaches the connector', async () => {
    const { router, connect, connector, agents } = harness();
    const connection = await connect();
    const stranger = agents.create({ name: 'stranger-agent' });

    // No identity at all: the router refuses to run.
    await expect(router.call(`${connection.id}__get_status`, {})).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });

    // Denied: the answer is the unknown-tool answer, and nothing was routed.
    await expect(
      router.call(`${connection.id}__get_status`, {}, { agent: stranger }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(connector.executions).toHaveLength(0);
    expect(activity()).toHaveLength(0);
  });

  it('routes an allowed managed call through the connector and records it with the connection id', async () => {
    const { router, connect, connector, agents, policies } = harness();
    const connection = await connect();

    const agent = agents.create({ name: 'reader' });
    const grant = policies.create({ name: 'fixture-tools', rules: [allow(`${connection.id}__get_status`)] });
    policies.assign(agent.id, grant.id);

    const routed = await router.call(`${connection.id}__get_status`, { q: 'hello' }, { agent, requestId: 'req-1' });

    expect(routed.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: connection.id });
    expect(connector.executions).toHaveLength(1);
    expect(connector.executions[0]!.toolName).toBe('get_status');
    expect(connector.executions[0]!.args).toEqual({ q: 'hello' });

    // The connector received its context and nothing else: no store handle is
    // part of the contract (ADR-049), so it is not part of the object.
    expect(Object.keys(connector.executions[0]!.context).sort()).toEqual([
      'connectionId',
      'metadata',
      'resolveCredential',
      'signal',
      'timeoutMs',
    ]);

    const row = activity().at(0);
    expect(row).toMatchObject({
      toolName: `${connection.id}__get_status`,
      outcome: 'success',
      connectionId: connection.id,
      requestId: 'req-1',
    });
    // The identity split is observable: a managed call names no backend.
    expect(row?.backendId).toBeUndefined();
  });

  it('participates in the existing policy model: tool-scoped rules and wildcards, never a backend rule', async () => {
    const { router, connect, agents, policies } = harness();
    const connection = await connect();

    // A `backend`-scoped rule naming a connection id is rejected at creation:
    // a connection is not a backend, and the two identity domains do not
    // merge (ADR-048). Nothing about policy validation weakens for Phase 12.
    expect(() => policies.create({ name: 'spoof', rules: [allow(connection.id, 'backend')] })).toThrow(AppError);

    // The participation path is the tool-scoped rule: exact public name or
    // the wildcard, evaluated before the source seam exactly as for MCP.
    const agent = agents.create({ name: 'org-admin' });
    const exact = policies.create({ name: 'one-tool', rules: [allow(`${connection.id}__run_job`)] });
    const wildcard = policies.create({ name: 'wild', rules: [allow('*')] });
    policies.assign(agent.id, exact.id);
    policies.assign(agent.id, wildcard.id);

    await expect(router.call(`${connection.id}__run_job`, {}, { agent })).resolves.toMatchObject({
      tool: { publicName: `${connection.id}__run_job` },
    });
  });

  it('maps every connector failure kind to a fixed code, with the connector message in details only', async () => {
    for (const [kind, code] of [
      ['timeout', 'BACKEND_TIMEOUT'],
      ['unreachable', 'BACKEND_UNAVAILABLE'],
      ['invalid_request', 'VALIDATION_ERROR'],
      ['provider_error', 'BACKEND_CONNECTION_ERROR'],
    ] as const) {
      const failing = fixtureConnector({ error: { kind, message: `fixture ${kind}` } });
      const { router, connect, agents, policies } = harness({ connector: failing });
      const connection = await connect();
      // One store backs every loop iteration: names must stay unique.
      const agent = agents.create({ name: `caller-${kind}` });
      const grant = policies.create({ name: `all-${kind}`, rules: [allow('*')] });
      policies.assign(agent.id, grant.id);

      const thrown = await router.call(`${connection.id}__get_status`, {}, { agent }).then(
        () => null,
        (error: AppError) => error,
      );

      expect(thrown, kind).toMatchObject({ code });
      // The client-facing message is fixed; the connector's words stay internal.
      expect(thrown!.details).toMatchObject({ connectorMessage: `fixture ${kind}` });
      expect(activity().at(0)).toMatchObject({ outcome: 'failure', errorCode: code, connectionId: connection.id });
    }
  });

  it('treats a reauthorization failure as permanent: status flips, tools withdrawn, call closed', async () => {
    const failing = fixtureConnector({
      error: { kind: 'reauthorization_required', message: 'token rejected by fixture' },
    });
    const { router, connect, integrations, catalog, agents, policies } = harness({ connector: failing });
    const connection = await connect();

    const agent = agents.create({ name: 'caller' });
    const grant = policies.create({ name: 'all', rules: [allow('*')] });
    policies.assign(agent.id, grant.id);

    await expect(router.call(`${connection.id}__get_status`, {}, { agent })).rejects.toMatchObject({
      code: 'TOOL_UNAVAILABLE',
    });

    expect(integrations.list()[0]?.status).toBe('reauthorization_required');
    expect(catalog.listAll()).toEqual([]);
    // Terminal: no further dispatch is possible through this connection.
    await expect(router.call(`${connection.id}__get_status`, {}, { agent })).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
  });

  it('fails closed when the runtime says the connection is unavailable', async () => {
    const { router, connect, integrations, agents, policies } = harness();
    const connection = await connect();

    // The stale-mapping case the runtime gate exists for: the connection row
    // stopped being callable while the in-memory catalog still lists the
    // tool. (The service's own disconnect removes both; writing the status
    // directly simulates the race or an external write.)
    store.integrationConnections.updateStatus(connection.id, 'disconnected', NOW);
    expect(integrations.dispatchable(connection.id)).toMatchObject({
      unavailable: expect.stringContaining('disconnected'),
    });

    const agent = agents.create({ name: 'runtime-caller' });
    const grant = policies.create({ name: 'runtime-all', rules: [allow('*')] });
    policies.assign(agent.id, grant.id);

    await expect(router.call(`${connection.id}__get_status`, {}, { agent })).rejects.toMatchObject({
      code: 'TOOL_UNAVAILABLE',
    });
    expect(activity().at(0)).toMatchObject({ errorCode: 'TOOL_UNAVAILABLE' });
  });

  it('fails closed with no runtime wired: there is no MCP fallback behind the seam', async () => {
    const catalog = new ToolCatalog();
    const { tools } = buildIntegrationTools({
      connectionId: '55555555-5555-4555-8555-555555555555',
      now: NOW,
      tools: [def('get_status')],
      rejected: [],
    });
    catalog.replace({ sourceType: 'managed_integration', sourceId: '55555555-5555-4555-8555-555555555555', tools });

    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    await expect(router.call('55555555-5555-4555-8555-555555555555__get_status', {})).rejects.toMatchObject({
      code: 'TOOL_UNAVAILABLE',
    });
    expect(activity().at(0)).toMatchObject({ errorCode: 'TOOL_UNAVAILABLE' });
  });

  it('passes a connector `isError` answer through as a routed result and a failed call', async () => {
    const erroring = fixtureConnector({
      result: () => ({ content: [{ type: 'text', text: 'fixture tool error' }], isError: true }),
    });
    const { router, connect, agents, policies } = harness({ connector: erroring });
    const connection = await connect();

    const agent = agents.create({ name: 'caller' });
    const grant = policies.create({ name: 'all', rules: [allow('*')] });
    policies.assign(agent.id, grant.id);

    // A tool-level failure is a successful round trip: no throw.
    const routed = await router.call(`${connection.id}__get_status`, {}, { agent });
    expect(routed.result.isError).toBe(true);
    expect(activity().at(0)).toMatchObject({ outcome: 'failure', errorCode: 'TOOL_UNAVAILABLE' });
  });

  it('enforces the outer timeout budget against a connector that hangs', async () => {
    const slow = fixtureConnector({ delayMs: 2_000 });
    const { router, connect, agents, policies } = harness({ connector: slow, timeoutMs: 25 });

    const connection = await connect();
    const agent = agents.create({ name: 'caller' });
    const grant = policies.create({ name: 'all', rules: [allow('*')] });
    policies.assign(agent.id, grant.id);

    await expect(router.call(`${connection.id}__get_status`, {}, { agent })).rejects.toMatchObject({
      code: 'BACKEND_TIMEOUT',
    });
  });

  it('validates arguments against the connector-reported schema before dispatching', async () => {
    const strict = fixtureConnector({ tools: [def('get_status', { type: 'object', required: ['q'] })] });
    const { router, connect, connector, agents, policies } = harness({ connector: strict });
    const connection = await connect();

    const agent = agents.create({ name: 'caller' });
    const grant = policies.create({ name: 'all', rules: [allow('*')] });
    policies.assign(agent.id, grant.id);

    await expect(router.call(`${connection.id}__get_status`, {}, { agent })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(connector.executions).toHaveLength(0);
  });
});
