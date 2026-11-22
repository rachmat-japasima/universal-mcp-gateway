import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config/config.js';
import type { ToolDefinition } from '../src/domain/tool.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { ToolCatalog } from '../src/routing/catalog.js';
import type { Connector, ConnectorError } from '../src/integrations/connector.js';
import { IntegrationService } from '../src/integrations/service.js';
import type { IntegrationConnection } from '../src/integrations/connection.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';

/**
 * Lifecycle concurrency, refresh-in-place, and connection isolation (Phase 15).
 *
 * Discovery is a network flight, so lifecycle actions can interleave with it.
 * The rule under test: the actor that still holds the row in `connecting`
 * after the flight owns the outcome — a racing delete, disconnect, or disable
 * wins, and a connect continuation never resurrects what that action took
 * down. Everything runs against the production `IntegrationService` with a
 * gated fixture connector; nothing touches a network.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const NOW = '2026-11-23T00:00:00.000Z';
const PROVIDER_ID = 'fixture-concurrency';

const def = (name: string): ToolDefinition => ({ name, inputSchema: { type: 'object' } });

/** One in-flight discovery: what it will answer, and when the test releases it. */
interface Flight {
  tools?: ToolDefinition[];
  fail?: ConnectorError;
  open: () => void;
  wait: () => Promise<void>;
}

/**
 * A connector whose every `discoverTools` call blocks on one queued flight.
 * `queue()` arms the next discovery and hands back its gate, so a test can
 * hold the flight open, interleave another lifecycle action, then release.
 */
function controllableConnector() {
  const flights: Flight[] = [];

  const connector: Connector = {
    discoverTools: async () => {
      const flight = flights.shift();
      if (flight === undefined) {
        return { ok: false as const, error: { kind: 'unreachable', message: 'no flight was queued' } };
      }
      await flight.wait();
      return flight.fail !== undefined
        ? { ok: false as const, error: flight.fail }
        : { ok: true as const, value: flight.tools ?? [def('get_status')] };
    },

    executeTool: async () => ({
      ok: true as const,
      value: { content: [{ type: 'text', text: '{}' }] } satisfies CallToolResult,
    }),
  };

  return {
    connector,
    /** Arms the next discovery and hands back the gate that releases it. */
    queue(armed: { tools?: ToolDefinition[]; fail?: ConnectorError } = {}): () => void {
      let release: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      flights.push({ ...armed, open: release, wait: () => wait });
      return release;
    },
    /** Arms a flight that is already open: discovery answers immediately. */
    queueNow(armed: { tools?: ToolDefinition[]; fail?: ConnectorError } = {}): void {
      this.queue(armed)();
    },
  };
}

let directory: string;
let store: Database;

function harness() {
  const catalog = new ToolCatalog();
  const registry = new ProviderRegistry();
  const control = controllableConnector();
  registry.register(
    {
      id: PROVIDER_ID,
      name: 'Fixture Provider',
      description: 'Throwaway provider for the concurrency tests.',
      capabilities: ['discovery', 'execution'],
      metadata: {},
    },
    control.connector,
  );

  const vault = new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') }));
  const integrations = new IntegrationService({
    store,
    registry,
    vault,
    catalog,
    logger,
    timeoutMs: 5_000,
    now: () => NOW,
  });

  return { catalog, integrations, control };
}

function newConnection(integrations: IntegrationService, name = 'fixture-connection'): IntegrationConnection {
  return integrations.create({ id: randomUUID(), providerId: PROVIDER_ID, name, metadata: {} });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-conc-'));
  store = openStore({ path: join(directory, 'gateway.db') });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('lifecycle concurrency', () => {
  it('rejects a second connect while the first is in flight, and the first still lands', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    const open = control.queue();

    const inFlight = integrations.connect(created.id);
    await expect(integrations.connect(created.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });

    open();
    const { connection: connected } = await inFlight;
    expect(connected.status).toBe('connected');
    expect(catalog.listByConnection(created.id)).toHaveLength(1);
  });

  it('lets a mid-flight disconnect win: nothing is published and the row stays at rest', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    const open = control.queue();

    const inFlight = integrations.connect(created.id);
    expect(integrations.disconnect(created.id).status).toBe('disconnected');

    open();
    await expect(inFlight).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });

    expect(store.integrationConnections.findById(created.id)?.status).toBe('disconnected');
    expect(catalog.listByConnection(created.id)).toHaveLength(0);
  });

  it('lets a mid-flight delete win: the connect ends not-found and no ghost tools remain', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    const open = control.queue();

    const inFlight = integrations.connect(created.id);
    integrations.remove(created.id);

    open();
    await expect(inFlight).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    expect(store.integrationConnections.findById(created.id)).toBeUndefined();
    expect(catalog.listAll()).toHaveLength(0);
  });
});

describe('refresh in place', () => {
  it('re-runs enable on a connected connection: discovery replaces tools without a disconnect', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    control.queueNow({ tools: [def('get_status')] });
    const { connection: first } = await integrations.connect(created.id);
    expect(first.status).toBe('connected');

    control.queueNow({ tools: [def('get_status'), def('run_job')] });
    const { connection: refreshed, outcome } = await integrations.connect(created.id);

    expect(refreshed.status).toBe('connected');
    expect(catalog.listByConnection(created.id).map((tool) => tool.publicName)).toEqual([
      `${created.id}__get_status`,
      `${created.id}__run_job`,
    ]);
    expect(outcome.added).toEqual(['run_job']);
  });

  it('withdraws stale tools when a refresh fails, lands in error, and audits the failure', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    control.queueNow({ tools: [def('get_status')] });
    await integrations.connect(created.id);
    expect(catalog.listByConnection(created.id)).toHaveLength(1);

    control.queueNow({ fail: { kind: 'unreachable', message: 'fixture provider is down' } });
    await expect(integrations.connect(created.id)).rejects.toMatchObject({ code: 'BACKEND_CONNECTION_ERROR' });

    expect(store.integrationConnections.findById(created.id)?.status).toBe('error');
    expect(catalog.listByConnection(created.id)).toHaveLength(0);
    const failure = store.audit.list(50).find((event) => event.result === 'failure');
    expect(failure?.action).toBe('integration.connection.updated');
    expect(failure?.metadata).toMatchObject({ status: 'error', kind: 'unreachable' });
  });

  it('lands a refused refresh credential in reauthorization_required with tools withdrawn', async () => {
    const { catalog, integrations, control } = harness();
    const created = newConnection(integrations);
    control.queueNow({ tools: [def('get_status')] });
    await integrations.connect(created.id);

    control.queueNow({ fail: { kind: 'reauthorization_required', message: 'fixture refused the token' } });
    await expect(integrations.connect(created.id)).rejects.toMatchObject({ code: 'BACKEND_CONNECTION_ERROR' });

    expect(store.integrationConnections.findById(created.id)?.status).toBe('reauthorization_required');
    expect(catalog.listByConnection(created.id)).toHaveLength(0);
  });
});

describe('connection isolation', () => {
  it('scopes credential resolution to its own connection: a foreign reference is refused', async () => {
    const { integrations } = harness();
    const alpha = newConnection(integrations, 'alpha');
    const beta = newConnection(integrations, 'beta');
    integrations.storeCredential(alpha.id, 'token-alpha');
    integrations.storeCredential(beta.id, 'token-beta');

    // Re-read: `storeCredential` moved the vault reference onto the rows.
    const sealedAlpha = integrations.get(alpha.id);
    const sealedBeta = integrations.get(beta.id);

    const resolveForAlpha = integrations.resolveCredentialFor({ id: alpha.id });
    await expect(resolveForAlpha(sealedAlpha.credentialId!)).resolves.toBe('token-alpha');
    await expect(resolveForAlpha(sealedBeta.credentialId!)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const resolveForBeta = integrations.resolveCredentialFor({ id: beta.id });
    await expect(resolveForBeta(sealedBeta.credentialId!)).resolves.toBe('token-beta');
  });
});
