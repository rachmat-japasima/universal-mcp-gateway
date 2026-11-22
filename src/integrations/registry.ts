import { AppError } from '../shared/errors.js';
import {
  providerDefinitionSchema,
  type ProviderDefinition,
  type ProviderRegistration,
} from './provider.js';
import type { Connector } from './connector.js';
import { githubConnector } from './github/connector.js';
import { notionConnector } from './notion/connector.js';
import { slackConnector } from './slack/connector.js';

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
 * personal access token; Notion (ADR-055), read-only through an internal
 * connection token; Slack (ADR-056), read-only through a manually supplied
 * bot token. Test fixtures register throwaway providers in their own
 * registry instance; this list stays production truth.
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

/**
 * The Notion registration (ADR-055), exported for the same reason as the
 * GitHub one: its contract tests wire the production registration to a
 * fixture connector, so the registration under test is the one shipped.
 */
export const notionRegistration: ProviderRegistration = {
  id: 'notion',
  name: 'Notion',
  description:
    'Read-only Notion access through an internal connection token. Six tools cover search, pages, blocks, databases, and data sources. The connection only sees pages and databases explicitly shared with it in Notion, and the token needs Read content only — no update, insert, comment, or user-information capabilities.',
  capabilities: ['discovery', 'execution'],
  metadata: {
    authMethod: 'internal connection token',
    requiredPermissions: ['Read content'],
    apiOrigin: 'https://api.notion.com',
    docs: 'https://developers.notion.com/reference/intro',
  },
};

/**
 * The Slack registration (ADR-056), exported for the same reason as the
 * GitHub and Notion ones: its contract tests wire the production
 * registration to a fixture connector, so the registration under test is
 * the one shipped.
 */
export const slackRegistration: ProviderRegistration = {
  id: 'slack',
  name: 'Slack',
  description:
    'Read-only Slack access through a manually supplied bot token. Five tools cover conversations, message history, thread replies, and users; the bot sees only what its read scopes and memberships allow — private channels must invite it, and there is no search, no write, and no file download.',
  capabilities: ['discovery', 'execution'],
  metadata: {
    authMethod: 'bot user OAuth token (xoxb-), manually supplied',
    requiredPermissions: [
      'channels:read',
      'channels:history',
      'groups:read',
      'groups:history',
      'im:read',
      'im:history',
      'mpim:read',
      'mpim:history',
      'users:read',
    ],
    apiOrigin: 'https://slack.com/api',
    docs: 'https://docs.slack.dev/reference/methods',
  },
};

/** Production registrations; each entry is reviewed code, not config. */
const REGISTRATIONS: ReadonlyArray<{ registration: ProviderRegistration; connector: Connector }> = [
  { registration: githubRegistration, connector: githubConnector },
  { registration: notionRegistration, connector: notionConnector },
  { registration: slackRegistration, connector: slackConnector },
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
 * (GitHub ADR-053, Notion ADR-055, Slack ADR-056); tests construct their own
 * instance instead of mutating this one.
 */
export const providerRegistry = new ProviderRegistry(REGISTRATIONS);
