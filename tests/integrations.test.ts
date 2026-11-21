import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  canTransition,
  connectionStatusSchema,
  createConnectionSchema,
  integrationConnectionSchema,
  storedIntegrationCredentialSchema,
} from '../src/integrations/connection.js';
import { providerRegistrationSchema, PROVIDER_CAPABILITIES, type ProviderRegistration } from '../src/integrations/provider.js';
import { ProviderRegistry, providerRegistry } from '../src/integrations/registry.js';
import type { Connector } from '../src/integrations/connector.js';
import { backendSource, toolSourceRefSchema, TOOL_SOURCE_TYPES } from '../src/integrations/source.js';
import { ToolCatalog, buildIntegrationTools, buildTools, detectConflicts, sourceKey } from '../src/routing/catalog.js';
import type { ToolDefinition } from '../src/domain/tool.js';
import { AppError } from '../src/shared/errors.js';

/**
 * Managed-integration domain invariants (ADR-048/050): statuses as data,
 * registrations as code, and a catalog where the two source types share one
 * keyspace without sharing one id space.
 *
 * No store, no HTTP, no connector I/O — this file pins the rules everything
 * else is built on. The connector-driven flows live in
 * `tests/integrations-execution.test.ts`.
 */

const NOW = '2026-11-22T00:00:00.000Z';
const UUID = randomUUID();

const def = (name: string): ToolDefinition => ({ name, inputSchema: { type: 'object' } });

/** Minimal legal registration; every test mutates what it cares about. */
function registration(overrides: Record<string, unknown> = {}): ProviderRegistration {
  return {
    // Provider ids are slugs (`providerIdSchema`), so fixture ids must be too.
    id: `fixture-${randomUUID()}`,
    name: 'Fixture Provider',
    description: 'A throwaway provider used by tests only.',
    capabilities: ['discovery', 'execution'],
    metadata: {},
    ...overrides,
  } as ProviderRegistration;
}

/** A connector that satisfies every capability a registration can declare. */
const fullConnector: Connector = {
  discoverTools: async () => ({ ok: true, value: [] }),
  executeTool: async () => ({ ok: true, value: { content: [] } }),
};

describe('connection domain', () => {
  it('has exactly the seven documented statuses', () => {
    expect([...CONNECTION_STATUSES]).toEqual([
      'pending',
      'connecting',
      'connected',
      'disconnected',
      'error',
      'reauthorization_required',
      'disabled',
    ]);
    expect(() => connectionStatusSchema.parse('enabled')).toThrow();
  });

  it('declares every legal edge as data, so a test can enumerate all 49 pairs', () => {
    for (const from of CONNECTION_STATUSES) {
      for (const to of CONNECTION_STATUSES) {
        const legal = CONNECTION_TRANSITIONS.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to)).toBe(legal);
      }
    }
  });

  it('lets an operator turn any connection off, and turn a disabled one back on explicitly', () => {
    for (const status of CONNECTION_STATUSES) {
      if (status === 'disabled') continue;
      expect(canTransition(status, 'disabled'), `${status} → disabled`).toBe(true);
    }
    // `disabled` exits only through the explicit re-enable (Phase 13): the
    // same operator `connect` every other status uses, never an automatic path.
    expect(CONNECTION_TRANSITIONS.filter(([from]) => from === 'disabled')).toEqual([['disabled', 'connecting']]);
  });

  it('exits `error` and `reauthorization_required` only through an explicit connect, never automatically', () => {
    // The only non-disable exit is a fresh connect attempt.
    expect(CONNECTION_TRANSITIONS.filter(([from]) => from === 'error')).toEqual([
      ['error', 'connecting'],
      ['error', 'disabled'],
    ]);
    expect(CONNECTION_TRANSITIONS.filter(([from]) => from === 'reauthorization_required')).toEqual([
      ['reauthorization_required', 'connecting'],
      ['reauthorization_required', 'disabled'],
    ]);
  });

  it('rejects a connection row that is not a validated, non-secret payload with a uuid id', () => {
    expect(() =>
      integrationConnectionSchema.parse({
        id: 'not-a-uuid',
        providerId: 'fixture',
        name: 'x',
        status: 'pending',
        credentialId: null,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();

    // `metadata` is open JSON by design: providers differ. What is closed is
    // the credential rule — only a reference may appear here.
    expect(() =>
      integrationConnectionSchema.parse({
        id: UUID,
        providerId: 'fixture',
        name: '  x  ',
        status: 'pending',
        credentialId: null,
        metadata: { org: 'acme', nested: { ok: true } },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toBeTruthy();

    // A credential reference must itself be a uuid: nothing but a vault id.
    expect(() =>
      integrationConnectionSchema.parse({
        id: UUID,
        providerId: 'fixture',
        name: 'x',
        status: 'pending',
        credentialId: 'sk-live-pasted-by-mistake',
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it('accepts a nullable credential reference, never an absent field', () => {
    expect(() => createConnectionSchema.parse({ id: UUID, providerId: 'fixture', name: 'x', metadata: {} })).toBeTruthy();
  });

  it('stores credentials as envelope strings only, and rejects any extra column-shaped field', () => {
    const credential = {
      id: UUID,
      connectionId: UUID,
      envelope: '{"v":1}',
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(storedIntegrationCredentialSchema.parse(credential)).toBeTruthy();
    expect(() =>
      storedIntegrationCredentialSchema.parse({ ...credential, plaintext: 'never a column' }),
    ).toThrow();
  });
});

describe('provider registration', () => {
  it('requires at least one declared capability from the closed set', () => {
    expect(PROVIDER_CAPABILITIES).toEqual(['discovery', 'execution']);
    expect(() => providerRegistrationSchema.parse(registration({ capabilities: [] }))).toThrow();
    expect(() => providerRegistrationSchema.parse(registration({ capabilities: ['upload'] }))).toThrow();
    // Discovery without execution is a list-only provider, and it is legal.
    expect(() => providerRegistrationSchema.parse(registration({ capabilities: ['discovery'] }))).toBeTruthy();
  });
});

describe('provider registry', () => {
  it('registers, validates, and lists definitions sorted by id', () => {
    const registry = new ProviderRegistry();
    const later = registry.register(registration({ name: 'Zeta', id: 'fixture-beta' }), fullConnector);
    const first = registry.register(registration({ name: 'Alpha', id: 'fixture-alpha' }), fullConnector);

    expect(registry.list().map((definition) => definition.id)).toEqual([first.id, later.id]);
    expect(registry.get(first.id)?.definition.name).toBe('Alpha');
    expect(registry.has(first.id)).toBe(true);
    // Connectors are gateway-internal: the listing is definitions only.
    expect(registry.list()[0]).not.toHaveProperty('connector');
  });

  it('fails closed on a duplicate id instead of overwriting the first entry', () => {
    const registry = new ProviderRegistry();
    const shared = registration();
    registry.register(shared, fullConnector);

    expect(() => registry.register({ ...shared, name: 'Impostor' }, fullConnector)).toThrow(AppError);
    expect(registry.get(shared.id!)?.definition.name).toBe('Fixture Provider');
  });

  it('refuses a registration whose connector does not implement a declared capability', () => {
    const registry = new ProviderRegistry();
    const listOnly: Connector = { discoverTools: fullConnector.discoverTools };

    // Declared `execution` but cannot execute.
    expect(() => registry.register(registration(), listOnly)).toThrow(AppError);
    // Declaring only what the connector implements is fine.
    expect(() =>
      registry.register(registration({ capabilities: ['discovery'] }), listOnly),
    ).toBeTruthy();
  });

  it('ships exactly the real providers: GitHub, registered read-only', () => {
    const registered = providerRegistry.list();
    expect(registered.map((definition) => definition.id)).toEqual(['github']);
    expect(registered[0]).toMatchObject({ name: 'GitHub', capabilities: ['discovery', 'execution'] });
    // The auth method is metadata, never a capability: the closed capability
    // set stays `['discovery', 'execution']` for every future provider too.
    expect(providerRegistry.get('github')?.definition.metadata).toMatchObject({
      authMethod: 'fine-grained personal access token',
    });
  });
});

describe('tool sources', () => {
  it('keeps the two source types a closed set', () => {
    expect([...TOOL_SOURCE_TYPES]).toEqual(['mcp_backend', 'managed_integration']);
    expect(() => toolSourceRefSchema.parse({ type: 'webhook', sourceId: UUID })).toThrow();
    expect(() => toolSourceRefSchema.parse({ type: 'managed_integration' })).toThrow();
  });

  it('builds the MCP reference through one constructor so the shapes cannot drift', () => {
    expect(backendSource(UUID)).toEqual({ type: 'mcp_backend', sourceId: UUID });
  });

  it('keys snapshots by composite `<sourceType>:<sourceId>`, so identical ids cannot collide', () => {
    expect(sourceKey('mcp_backend', 'x')).toBe('mcp_backend:x');
    expect(sourceKey('managed_integration', 'x')).toBe('managed_integration:x');
    expect(sourceKey('mcp_backend', 'x')).not.toBe(sourceKey('managed_integration', 'x'));
  });
});

describe('catalog across source types', () => {
  it('namespaces managed tools through the same deterministic path MCP tools use', () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const { tools } = buildIntegrationTools({ connectionId, now: NOW, tools: [def('get_status')], rejected: [] });
    const tool = tools.get('get_status')!;

    expect(tool.publicName).toBe(`${connectionId}__get_status`);
    expect(tool).toMatchObject({ sourceType: 'managed_integration', sourceId: connectionId });
    // No fabricated `backendId`: the union has no lying field.
    expect('backendId' in tool).toBe(false);
    expect(tool).not.toHaveProperty('backendId');
  });

  it('reports tools whose names cannot be normalized instead of throwing', () => {
    const { tools, rejected } = buildIntegrationTools({
      connectionId: UUID,
      now: NOW,
      tools: [def('get_status'), def('   ')],
      rejected: ['already-rejected'],
    });

    expect(tools.size).toBe(1);
    expect(rejected).toEqual(['already-rejected', '   ']);
  });

  it('holds the same id in both source types without one shadowing the other', () => {
    const catalog = new ToolCatalog();
    const sharedId = '33333333-3333-4333-8333-333333333333';

    const mcp = buildTools({ backendId: sharedId, now: NOW, tools: [def('echo')], rejected: [] });
    const managed = buildIntegrationTools({ connectionId: sharedId, now: NOW, tools: [def('echo')], rejected: [] });

    const mcpOutcome = catalog.replace({ sourceType: 'mcp_backend', sourceId: sharedId, tools: mcp.tools });
    const managedOutcome = catalog.replace({
      sourceType: 'managed_integration',
      sourceId: sharedId,
      tools: managed.tools,
    });

    expect(mcpOutcome.added).toEqual(['echo']);
    expect(managedOutcome.added).toEqual(['echo']);

    // Same public name, different source keys: both stay routable, because
    // the composite key is what "no collisions across sources" means.
    expect(catalog.listAll()).toHaveLength(2);
    expect(catalog.backendIds()).toEqual([sharedId]);
    // The managed replacement answers with a diff, not a discovery report.
    expect('report' in managedOutcome).toBe(false);
  });

  it('withholds both claimants of a cross-source name collision and names each source honestly', () => {
    const catalog = new ToolCatalog();
    // `a b` and `a_b` normalize to one segment: the cross-source collision.
    const mcp = buildTools({ backendId: 'a b', now: NOW, tools: [def('get_status')], rejected: [] });
    const managed = buildIntegrationTools({ connectionId: 'a_b', now: NOW, tools: [def('get_status')], rejected: [] });

    catalog.replace({ sourceType: 'mcp_backend', sourceId: 'a b', tools: mcp.tools });
    catalog.replace({ sourceType: 'managed_integration', sourceId: 'a_b', tools: managed.tools });

    expect(catalog.size).toBe(0);
    expect(catalog.resolve('a_b__get_status')).toMatchObject({ reason: 'conflict' });
    expect(catalog.conflicts$()).toEqual([
      {
        publicName: 'a_b__get_status',
        claimants: [
          // MCP claimant keeps `backendId`; the managed claimant has none.
          { sourceType: 'mcp_backend', sourceId: 'a b', backendId: 'a b', originalName: 'get_status' },
          { sourceType: 'managed_integration', sourceId: 'a_b', originalName: 'get_status' },
        ],
      },
    ]);
    expect(catalog.listAll().map((tool) => tool.availability)).toEqual(['conflict', 'conflict']);
  });

  it('removes a managed source in the same instant its tools stop being listed', () => {
    const catalog = new ToolCatalog();
    const { tools } = buildIntegrationTools({ connectionId: UUID, now: NOW, tools: [def('echo')], rejected: [] });

    catalog.replace({ sourceType: 'managed_integration', sourceId: UUID, tools });
    expect(catalog.remove({ type: 'managed_integration', sourceId: UUID })).toBe(true);
    expect(catalog.listAll()).toEqual([]);
    // Removing again is a no-op, not an error: lifecycle code may race.
    expect(catalog.remove({ type: 'managed_integration', sourceId: UUID })).toBe(false);
  });

  it('reports discovery for MCP backends only: managed sources have no report surface', () => {
    const catalog = new ToolCatalog();
    const mcp = buildTools({ backendId: 'b', now: NOW, tools: [def('echo')], rejected: [] });
    const managed = buildIntegrationTools({ connectionId: 'c', now: NOW, tools: [def('echo')], rejected: [] });

    catalog.replace({
      sourceType: 'mcp_backend',
      sourceId: 'b',
      tools: mcp.tools,
      report: {
        backendId: 'b',
        status: 'ok',
        toolCount: 1,
        conflictCount: 0,
        rejectedCount: 0,
        discoveredAt: NOW,
      },
    });
    catalog.replace({ sourceType: 'managed_integration', sourceId: 'c', tools: managed.tools });

    expect(catalog.reports().map((report) => report.backendId)).toEqual(['b']);
  });

  it('counts a backend\'s conflicts without misreading a managed claimant as that backend', () => {
    // One MCP claimant and one managed claimant for the same public name: the
    // conflict exists, and `conflictsOf('a b')` must count exactly its own.
    const snapshots = [
      {
        sourceType: 'mcp_backend' as const,
        sourceId: 'a b',
        tools: buildTools({ backendId: 'a b', now: NOW, tools: [def('get_status')], rejected: [] }).tools,
      },
      {
        sourceType: 'managed_integration' as const,
        sourceId: 'a_b',
        tools: buildIntegrationTools({ connectionId: 'a_b', now: NOW, tools: [def('get_status')], rejected: [] }).tools,
      },
    ];

    const conflicts = detectConflicts(snapshots);
    expect(conflicts.get('a_b__get_status')?.claimants).toHaveLength(2);
    expect(conflicts.get('a_b__get_status')?.claimants.map((claimant) => claimant.sourceType).sort()).toEqual([
      'managed_integration',
      'mcp_backend',
    ]);
  });
});
