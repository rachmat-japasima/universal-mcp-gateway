import { AppError } from '../shared/errors.js';
import {
  providerDefinitionSchema,
  type ProviderDefinition,
  type ProviderRegistration,
} from './provider.js';
import type { Connector } from './connector.js';
import { githubConnector } from './github/connector.js';

/**
 * Code-registered provider registry (ADR-050).
 *
 * No dynamic loading, no marketplace, no plugin directory — a provider exists
 * because a developer added it to `REGISTRATIONS` below, which makes every
 * entry reviewed and covered by the connector contract tests. The registry is
 * therefore a module constant, not a table: there is no operator write path,
 * so persisting it would only create a second copy that can drift from the
 * code.
 *
 * Production registrations: GitHub (ADR-053), read-only through a fine-grained
 * personal access token. Test fixtures register throwaway providers in their
 * own registry instance; this list stays production truth.
 */

/** A provider's code-side entry: its definition plus its connector. */
export interface RegisteredProvider {
  definition: ProviderDefinition;
  connector: Connector;
}

/**
 * The GitHub registration (ADR-053), exported so its contract tests wire the
 * production registration to a fixture connector — the registration under test
 * is the one the gateway ships, not a lookalike.
 */
export const githubRegistration: ProviderRegistration = {
  id: 'github',
  name: 'GitHub',
  description:
    'Read-only GitHub access through a fine-grained personal access token. Six tools cover repositories, issues, and pull requests; the token must carry Metadata (read) plus Issues and Pull requests (read) on the repositories it should see.',
  capabilities: ['discovery', 'execution'],
  metadata: {
    authMethod: 'fine-grained personal access token',
    requiredPermissions: ['Metadata:read', 'Issues:read', 'Pull requests:read'],
    apiOrigin: 'https://api.github.com',
    docs: 'https://docs.github.com/en/rest',
  },
};

/** Registrations go here when a real provider is implemented (Phase 13+). */
const REGISTRATIONS: ReadonlyArray<{ registration: ProviderRegistration; connector: Connector }> = [
  { registration: githubRegistration, connector: githubConnector },
];

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  /**
   * A registry registers exactly what it is handed — an empty instance is
   * empty, which is what test fixtures construct. The production singleton
   * below is the one wired with `REGISTRATIONS`.
   */
  constructor(registrations: ReadonlyArray<{ registration: ProviderRegistration; connector: Connector }> = []) {
    for (const entry of registrations) this.register(entry.registration, entry.connector);
  }

  /** Validates and registers one provider with its connector. Duplicate ids fail closed. */
  register(registration: ProviderRegistration, connector: Connector): ProviderDefinition {
    const definition = providerDefinitionSchema.parse({
      ...registration,
      registeredAt: new Date().toISOString(),
    });

    if (this.providers.has(definition.id)) {
      throw new AppError('RESOURCE_CONFLICT', `provider already registered: ${definition.id}`, {
        details: { providerId: definition.id },
      });
    }

    // The connector must implement every capability the definition declares,
    // checked here rather than at call time: a list-only provider that shipped
    // an `executeTool` would be just as wrong as an executable one without.
    for (const capability of definition.capabilities) {
      const method = capability === 'discovery' ? 'discoverTools' : 'executeTool';
      if (connector[method] === undefined) {
        throw new AppError('CONFIGURATION_ERROR', `provider "${definition.id}" declares ${capability} but its connector does not implement ${method}`, {
          details: { providerId: definition.id, capability },
        });
      }
    }

    this.providers.set(definition.id, { definition, connector });
    return definition;
  }

  /** Definitions only; connectors are gateway-internal and never serialized. */
  list(): ProviderDefinition[] {
    return [...this.providers.values()].map((entry) => entry.definition).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(providerId: string): RegisteredProvider | undefined {
    return this.providers.get(providerId);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

/**
 * The registry the gateway assembles with. Wired with the code registrations
 * (GitHub, ADR-053); tests construct their own instance instead of mutating
 * this one.
 */
export const providerRegistry = new ProviderRegistry(REGISTRATIONS);
