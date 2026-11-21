import { Hono } from 'hono';

import type { IntegrationConnection } from '../../integrations/connection.js';
import type { IntegrationService } from '../../integrations/service.js';
import type { ProviderRegistry } from '../../integrations/registry.js';
import { ok } from '../http.js';

/**
 * Managed-integration routes (Phase 12, ADR-052).
 *
 * Read-only by design: the domain service can create, connect and remove
 * connections, but no operator write path exists this phase — no provider is
 * registered in production, so a write endpoint would be a form over nothing.
 * Phase 13 mounts the write API on the same service.
 *
 * Empty states are accurate, not padded: with the production registry empty,
 * `providers` returns `[]` and `connections` returns `[]` because that is the
 * truth. No placeholder cards, no fabricated metrics, no credential values
 * — the only credential-adjacent field exposed is a vault reference id.
 */

export interface IntegrationRouteDependencies {
  registry: ProviderRegistry;
  integrations: IntegrationService;
}

function toProviderView(provider: ReturnType<ProviderRegistry['list']>[number]): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    capabilities: provider.capabilities,
    ...(Object.keys(provider.metadata).length === 0 ? {} : { metadata: provider.metadata }),
    registeredAt: provider.registeredAt,
  };
}

function toConnectionView(connection: IntegrationConnection, registry: ProviderRegistry): Record<string, unknown> {
  const provider = registry.get(connection.providerId);
  return {
    id: connection.id,
    providerId: connection.providerId,
    // A connection row survives a provider being unregistered; the view says
    // so instead of pretending the provider never existed.
    ...(provider === undefined ? {} : { providerName: provider.definition.name }),
    name: connection.name,
    status: connection.status,
    credentialId: connection.credentialId,
    metadata: connection.metadata,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function integrationsRoutes(deps: IntegrationRouteDependencies): Hono {
  const { registry } = deps;
  const routes = new Hono();

  /** Registered providers. Empty in production: the registry is code-only and ships zero entries. */
  routes.get('/providers', (c) => ok(c, registry.list().map(toProviderView)));

  /** Connections, newest first. Empty in production: no write path exists yet. */
  routes.get('/connections', (c) => {
    const connections = deps.integrations.list();
    return ok(c, connections.map((connection) => toConnectionView(connection, registry)));
  });

  return routes;
}
