import { AppError } from '../shared/errors.js';
import {
  providerDefinitionSchema,
  type ProviderDefinition,
  type ProviderRegistration,
} from './provider.js';
import type { Connector } from './connector.js';

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
 * The production registry is EMPTY (same stance as ADR-002 for backends).
 * Test fixtures register throwaway providers in their own registry instance;
 * nothing here ships a real provider.
 */

/** A provider's code-side entry: its definition plus its connector. */
export interface RegisteredProvider {
  definition: ProviderDefinition;
  connector: Connector;
}

/** Registrations go here when a real provider is implemented (Phase 13+). */
const REGISTRATIONS: ReadonlyArray<{ registration: ProviderRegistration; connector: Connector }> = [];

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  constructor(registrations: ReadonlyArray<{ registration: ProviderRegistration; connector: Connector }> = REGISTRATIONS) {
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
 * The registry the gateway assembles with. Empty in production by design;
 * tests construct their own instance instead of mutating this one.
 */
export const providerRegistry = new ProviderRegistry();
