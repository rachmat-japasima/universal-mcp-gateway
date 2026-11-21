import { randomUUID } from 'node:crypto';

import type { AuditAction, AuditMetadata } from '../domain/audit-event.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AppError } from '../shared/errors.js';
import type { ToolCatalog, IntegrationOutcome } from '../routing/catalog.js';
import { buildIntegrationTools } from '../routing/catalog.js';
import type { Actor } from '../registry/backend-service.js';
import { withCancellation, type ConnectorContext, type CredentialResolver } from './connector.js';
import { canTransition, type CreateConnectionInput, type IntegrationConnection } from './connection.js';
import { integrationConnectionSchema } from './connection.js';
import type { IntegrationDispatch, IntegrationRuntime } from './runtime.js';
import { ProviderRegistry } from './registry.js';
import { EnvelopeVault } from './vault.js';

/**
 * The managed-integration service (ADR-049/050/051).
 *
 * Owns the connection lifecycle, the credential path, and the discovery
 * integration. It is also the `IntegrationRuntime` the router dispatches
 * through — the seam's implementation, not a second pipeline.
 *
 * Discipline, same as the backend side: configuration changes are operator
 * actions and are audited; execution is the router's job and stays out of
 * here except for the dispatchable lookup, which is read-only.
 *
 * Phase 12 has no operator write API: these methods are the domain surface
 * that the Phase 13 API will expose, and they are what tests exercise. No
 * production provider exists, so nothing here can run in production today.
 */

export interface IntegrationServiceOptions {
  store: Database;
  registry: ProviderRegistry;
  vault: EnvelopeVault;
  catalog: ToolCatalog;
  logger: Logger;
  /** Upper bound for one connector operation (discovery or execution). */
  timeoutMs?: number;
  now?: () => string;
}

export class IntegrationService implements IntegrationRuntime {
  private readonly store: Database;
  private readonly registry: ProviderRegistry;
  private readonly vault: EnvelopeVault;
  private readonly catalog: ToolCatalog;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(options: IntegrationServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.vault = options.vault;
    this.catalog = options.catalog;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Connections, newest first. Read-only view for the management API. */
  list(): IntegrationConnection[] {
    return this.store.integrationConnections.list();
  }

  // -- Connection lifecycle ------------------------------------------------

  /** Creates a connection row. `pending`: it exists, nothing is verified. */
  create(input: CreateConnectionInput, actor: Actor = { type: 'admin', id: 'local-operator' }): IntegrationConnection {
    const parsed = integrationConnectionSchema.parse({
      ...input,
      status: 'pending',
      credentialId: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    });

    if (!this.registry.has(parsed.providerId)) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested provider is not registered.', {
        details: { providerId: parsed.providerId },
      });
    }

    const created = this.store.integrationConnections.create(parsed);
    this.audit(actor, 'integration.connection.created', 'connection', created.id, {
      providerId: created.providerId,
    });
    return created;
  }

  /** Updates operator-facing fields. Status is untouched: `transition` owns it. */
  update(
    connectionId: string,
    fields: { name?: string; metadata?: Record<string, unknown> },
    actor: Actor = { type: 'admin', id: 'local-operator' },
  ): IntegrationConnection {
    const updated = this.store.integrationConnections.update(connectionId, fields, this.now());
    if (updated === undefined) throw this.notFound(connectionId);
    this.audit(actor, 'integration.connection.updated', 'connection', updated.id, {});
    return updated;
  }

  /**
   * The one legal way to change status. Illegal edges throw instead of
   * "correcting" the caller, because a state machine that repairs input is a
   * state machine whose history lies.
   */
  private transition(connection: IntegrationConnection, to: string): IntegrationConnection {
    if (!canTransition(connection.status, to as IntegrationConnection['status'])) {
      throw new AppError('RESOURCE_CONFLICT', `The connection cannot move from "${connection.status}" to "${to}".`, {
        details: { connectionId: connection.id, from: connection.status, to },
      });
    }
    const updated = this.store.integrationConnections.updateStatus(connection.id, to as IntegrationConnection['status'], this.now());
    return updated ?? connection;
  }

  /**
   * Connect = discovery, for Phase 12's fixture connectors: the only way a
   * connection proves it can act is by listing its tools through the real
   * connector contract. A real provider's verification handshake (Phase 13)
   * will slot into the same method.
   */
  async connect(connectionId: string): Promise<{ connection: IntegrationConnection; outcome: IntegrationOutcome }> {
    const connection = this.require(connectionId);
    const provider = this.registry.get(connection.providerId);
    if (provider === undefined) {
      throw new AppError('CONFIGURATION_ERROR', 'The provider for this connection is no longer registered.', {
        details: { connectionId, providerId: connection.providerId },
      });
    }
    if (provider.connector.discoverTools === undefined) {
      throw new AppError('CONFIGURATION_ERROR', 'The provider does not declare discovery.', {
        details: { connectionId, providerId: connection.providerId },
      });
    }

    const connecting = this.transition(connection, 'connecting');
    const context = this.connectorContext(connecting);
    const result = await withCancellation(context, () => provider.connector.discoverTools!(context));

    if (!result.ok) {
      this.transition(connecting, 'error');
      throw new AppError('BACKEND_CONNECTION_ERROR', `Connecting "${connection.name}" failed.`, {
        details: { connectionId, connectorMessage: result.error.message, kind: result.error.kind },
      });
    }

    const { tools, rejected } = buildIntegrationTools({
      connectionId,
      now: this.now(),
      tools: result.value,
      rejected: [],
    });

    const outcome = this.catalog.replace({
      sourceType: 'managed_integration',
      sourceId: connectionId,
      tools,
    });

    const connected = this.transition(connecting, 'connected');
    this.logger.info(
      { connectionId, tools: tools.size, rejected: rejected.length, outcome },
      'Managed connection connected',
    );
    return { connection: connected, outcome };
  }

  /** At rest, tools withdrawn in the same instant (the catalog is derived). */
  disconnect(connectionId: string): IntegrationConnection {
    const connection = this.require(connectionId);
    const disconnected = this.transition(connection, 'disconnected');
    this.catalog.remove({ type: 'managed_integration', sourceId: connectionId });
    return disconnected;
  }

  /** Terminal for routing in Phase 12; the row survives. */
  disable(connectionId: string, actor: Actor = { type: 'admin', id: 'local-operator' }): IntegrationConnection {
    const connection = this.require(connectionId);
    const disabled = this.transition(connection, 'disabled');
    this.catalog.remove({ type: 'managed_integration', sourceId: connectionId });
    this.audit(actor, 'integration.connection.updated', 'connection', disabled.id, { status: 'disabled' });
    return disabled;
  }

  /**
   * Hard delete: tools are withdrawn first, then the row, then its credentials
   * cascade (migration 0008) — no order leaves a callable tool behind.
   */
  remove(connectionId: string, actor: Actor = { type: 'admin', id: 'local-operator' }): void {
    const connection = this.require(connectionId);
    this.catalog.remove({ type: 'managed_integration', sourceId: connectionId });
    this.store.integrationConnections.remove(connection.id);
    this.audit(actor, 'integration.connection.deleted', 'connection', connection.id, {
      providerId: connection.providerId,
    });
  }

  // -- Credentials ----------------------------------------------------------

  /**
   * Seals one credential value into the vault and links it to the connection.
   * The value exists only in this call's argument and the vault's memory;
   * everything persistent is ciphertext (ADR-051).
   */
  storeCredential(connectionId: string, value: string, actor: Actor = { type: 'admin', id: 'local-operator' }): void {
    const connection = this.require(connectionId);
    const now = this.now();
    const credentialId = randomUUID();

    const envelope = this.vault.seal(value);

    this.store.transaction(() => {
      this.store.integrationCredentials.create({
        id: credentialId,
        connectionId: connection.id,
        envelope,
        createdAt: now,
        updatedAt: now,
      });
      this.store.integrationConnections.updateCredential(connection.id, credentialId, now);
    });

    this.audit(actor, 'integration.credential.sealed', 'connection', connection.id, { credentialId });
  }

  /**
   * The resolver handed to connectors: reference in, value out, audit row
   * between — the value never enters a log line (ADR-052).
   */
  readonly resolveCredential: CredentialResolver = async (credentialId: string): Promise<string> => {
    const record = this.store.integrationCredentials.findById(credentialId);
    if (record === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The stored credential no longer exists.', {
        details: { credentialId },
      });
    }

    const value = this.vault.unseal(record.envelope);

    this.audit({ type: 'system' }, 'integration.credential.resolved', 'connection', record.connectionId ?? credentialId, {
      credentialId,
    });
    return value;
  };

  // -- The router seam -----------------------------------------------------

  dispatchable(connectionId: string): { dispatch: IntegrationDispatch } | { unavailable: string } {
    const connection = this.store.integrationConnections.findById(connectionId);
    if (connection === undefined) return { unavailable: 'The connection no longer exists.' };
    if (connection.status !== 'connected') {
      return { unavailable: `The connection status is "${connection.status}".` };
    }

    const provider = this.registry.get(connection.providerId);
    if (provider === undefined) {
      return { unavailable: `The provider "${connection.providerId}" is not registered.` };
    }
    if (provider.connector.executeTool === undefined) {
      return { unavailable: 'The provider does not declare execution.' };
    }

    // A linked credential must be resolvable: a dangling reference or an
    // unsealable envelope means the call would fail mid-flight, which is
    // exactly what this gate exists to make a cheap refusal instead.
    if (connection.credentialId !== null) {
      const record = this.store.integrationCredentials.findById(connection.credentialId);
      if (record === undefined) return { unavailable: 'The stored credential no longer exists.' };
      if (!this.vault.configured) return { unavailable: 'The credential vault is not configured.' };
    }

    return {
      dispatch: {
        connection,
        executeTool: provider.connector.executeTool,
        resolveCredential: this.resolveCredential,
        timeoutMs: this.timeoutMs,
      },
    };
  }

  markReauthorizationRequired(connectionId: string): void {
    const connection = this.store.integrationConnections.findById(connectionId);
    if (connection === undefined) return;
    if (!canTransition(connection.status, 'reauthorization_required')) return;
    const updated = this.store.integrationConnections.updateStatus(
      connectionId,
      'reauthorization_required',
      this.now(),
    );
    this.catalog.remove({ type: 'managed_integration', sourceId: connectionId });
    if (updated !== undefined) {
      this.logger.warn({ connectionId }, 'Connection requires reauthorization');
    }
  }

  // -- Internals -------------------------------------------------------------

  private require(connectionId: string): IntegrationConnection {
    const connection = this.store.integrationConnections.findById(connectionId);
    if (connection === undefined) throw this.notFound(connectionId);
    return connection;
  }

  private notFound(connectionId: string): AppError {
    return new AppError('RESOURCE_NOT_FOUND', 'The requested connection does not exist.', {
      details: { connectionId },
    });
  }

  private connectorContext(connection: IntegrationConnection): ConnectorContext {
    return {
      connectionId: connection.id,
      metadata: connection.metadata,
      resolveCredential: this.resolveCredential,
      timeoutMs: this.timeoutMs,
      // Discovery has no inbound request to cancel; the timeout is the bound.
      signal: new AbortController().signal,
    };
  }

  /** One audit row per administrative action. Never a value, never an envelope. */
  private audit(
    actor: Actor,
    action: AuditAction,
    targetType: 'connection',
    targetId: string,
    metadata: AuditMetadata,
  ): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: actor.type,
      ...(actor.id === undefined ? {} : { actorId: actor.id }),
      action,
      targetType,
      targetId,
      result: 'success',
      createdAt: this.now(),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    });
  }
}
