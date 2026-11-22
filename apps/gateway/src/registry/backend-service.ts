import { randomUUID } from 'node:crypto';

import type { AuditAction } from '../domain/audit-event.js';
import type { Backend, CreateBackendInput, UpdateBackendInput } from '../domain/backend.js';
import { backendSchema, createBackendSchema, updateBackendSchema } from '../domain/backend.js';
import { initialBackendRuntime } from '../domain/backend-runtime.js';
import type { BackendPage, BackendQuery } from '../domain/repositories.js';
import type { Database } from '../infrastructure/database/index.js';
import { metrics } from '../monitoring/metrics.js';
import { AppError, safeIssueMessage, safeIssuePath } from '../shared/errors.js';

/**
 * Backend registry service.
 *
 * Owns the rules that span more than one write: uniqueness, runtime-state
 * initialisation, audit events, and the transaction that keeps them consistent.
 * Routes only parse and format; repositories only persist.
 *
 * Phase 3 is configuration-only. Nothing here connects, spawns, or resolves
 * anything: a register/update/enable call cannot cause network or process
 * activity, which is why it is safe to expose the API before adapters exist.
 */

export interface Actor {
  type: 'admin' | 'agent' | 'system';
  /** Known once dashboard auth exists (Phase 6); `undefined` until then. */
  id?: string;
}

/**
 * The unauthenticated local operator. Phase 3 has no dashboard auth, so the only
 * caller is the local user. It is recorded explicitly so audit rows written now
 * do not look like anonymous or system activity later.
 */
export const LOCAL_OPERATOR: Actor = { type: 'admin', id: 'local-operator' };

export interface BackendListItem extends Backend {
  /** Runtime row if one exists. Absent for backends registered before any adapter ran. */
  runtime?: { status: string; updatedAt: string };
}

export interface ValidationResult {
  valid: boolean;
  transport?: string;
  /** Redacted view of the normalised config; secrets never appear. */
  normalized?: Record<string, unknown>;
  errors?: Array<{ path: string; message: string }>;
}

export class BackendService {
  constructor(
    private readonly store: Database,
    private readonly actor: Actor = LOCAL_OPERATOR,
  ) {}

  list(query: BackendQuery): BackendPage & { items: BackendListItem[] } {
    const page = this.store.backends.query(query);

    return { total: page.total, items: page.items.map((backend) => this.withRuntime(backend)) };
  }

  get(backendId: string): BackendListItem {
    return this.withRuntime(this.requireBackend(backendId));
  }

  /**
   * Registers a backend and its initial runtime row in one transaction.
   *
   * The runtime row starts `disconnected`/`disabled` — never `connected` — so a
   * definition can never imply a live connection.
   */
  create(input: CreateBackendInput): BackendListItem {
    const parsed = createBackendSchema.parse(input);
    const now = this.now();

    const created = this.store.transaction(() => {
      const existing = this.store.backends.findByName(parsed.name);
      if (existing !== undefined) {
        throw new AppError('RESOURCE_CONFLICT', 'A backend with that name already exists.', {
          details: { name: parsed.name },
        });
      }

      const backend = this.store.backends.create(parsed, now);
      this.store.backendRuntime.upsert(initialBackendRuntime(backend.id, backend.enabled, now));
      this.audit('backend.created', 'success', backend, { transport: backend.connection.type, enabled: backend.enabled });

      return backend;
    });

    return this.withRuntime(created);
  }

  update(backendId: string, input: UpdateBackendInput, expectedVersion?: number): BackendListItem {
    const parsed = updateBackendSchema.parse(input);

    return this.store.transaction(() => {
      const existing = this.requireBackend(backendId);

      // Renaming onto another backend's name is a conflict, not a database error
      // surfacing as an opaque 409.
      if (parsed.name !== undefined && parsed.name !== existing.name) {
        const clash = this.store.backends.findByName(parsed.name);
        if (clash !== undefined && clash.id !== backendId) {
          throw new AppError('RESOURCE_CONFLICT', 'A backend with that name already exists.', {
            details: { name: parsed.name },
          });
        }
      }

      const updated = this.store.backends.update(backendId, parsed, this.now(), expectedVersion);

      // Keep the runtime row consistent with configuration state without
      // inventing connection transitions: only the disabled/not-disabled axis.
      if (updated.enabled !== existing.enabled) {
        metrics.increment('umg_backend_changes_total', { action: updated.enabled ? 'enabled' : 'disabled' });
        this.syncEnabledRuntime(updated);
      }

      this.audit('backend.updated', 'success', updated, {
        changed: changedFields(existing, updated).join(','),
      });

      return this.withRuntime(updated);
    });
  }

  /** Idempotent: re-enabling an enabled backend changes nothing and writes no audit row. */
  setEnabled(backendId: string, enabled: boolean, expectedVersion?: number): BackendListItem {
    return this.store.transaction(() => {
      const existing = this.requireBackend(backendId);

      if (existing.enabled === enabled) {
        if (expectedVersion !== undefined && expectedVersion !== existing.version) {
          throw new AppError('RESOURCE_CONFLICT', 'The backend was modified by another request. Reload and retry.', {
            details: { backendId },
          });
        }
        return this.withRuntime(existing);
      }

      const updated = this.store.backends.update(backendId, { enabled }, this.now(), expectedVersion);
      metrics.increment('umg_backend_changes_total', { action: enabled ? 'enabled' : 'disabled' });
      this.syncEnabledRuntime(updated);
      this.audit(enabled ? 'backend.enabled' : 'backend.disabled', 'success', updated, {});

      return this.withRuntime(updated);
    });
  }

  /**
   * Tombstones the backend. Dependent rows survive by design: the runtime row
   * cascades, activity/audit rows keep their reference (ADR-024).
   */
  remove(backendId: string): BackendListItem {
    return this.store.transaction(() => {
      const existing = this.requireBackend(backendId);
      const withRuntime = this.withRuntime(existing);

      this.store.backends.softDelete(backendId, this.now());
      this.audit('backend.deleted', 'success', existing, { name: existing.name });

      // Returned with the state it had just before deletion: what the caller saw.
      return withRuntime;
    });
  }

  /**
   * Validates a proposed configuration without persisting or connecting.
   *
   * Purely local: schema parsing plus redaction. No DNS lookup, no socket, no
   * process spawn — a validation call from the dashboard cannot be used to probe
   * an internal network.
   */
  validate(input: unknown): ValidationResult {
    const parsed = createBackendSchema.safeParse(input);

    if (!parsed.success) {
      // Reuse the shared formatter so a secret pasted as an env-var or header
      // *name* cannot be echoed here or persisted into the audit log.
      const errors = parsed.error.issues.slice(0, 20).map((issue) => ({
        path: safeIssuePath(issue.path),
        message: safeIssueMessage(issue),
      }));

      this.auditValidationFailure('schema', errors.map((error) => error.path));

      return { valid: false, errors };
    }

    return {
      valid: true,
      transport: parsed.data.connection.type,
      normalized: redactConnectionForDisplay(parsed.data),
    };
  }

  /** Attaches the runtime row when one exists; configuration stands alone otherwise. */
  private withRuntime(backend: Backend): BackendListItem {
    const runtime = this.store.backendRuntime.findByBackendId(backend.id);

    return runtime === undefined
      ? backend
      : { ...backend, runtime: { status: runtime.status, updatedAt: runtime.updatedAt } };
  }

  private syncEnabledRuntime(backend: Backend): void {
    const runtime = this.store.backendRuntime.findByBackendId(backend.id);
    if (runtime === undefined) return;

    // Only the two configuration-visible states are touched. A backend that was
    // `error` stays `error`; enabling configuration does not fabricate a connect.
    if (!backend.enabled && runtime.status !== 'disabled') {
      this.store.backendRuntime.upsert({ ...runtime, status: 'disabled', updatedAt: this.now() });
      return;
    }

    if (backend.enabled && runtime.status === 'disabled') {
      this.store.backendRuntime.upsert({ ...runtime, status: 'disconnected', updatedAt: this.now() });
    }
  }

  private requireBackend(backendId: string): Backend {
    const backend = this.store.backends.findById(backendId);
    if (backend === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', {
        details: { backendId },
      });
    }

    return backend;
  }

  private audit(
    action: AuditAction,
    result: 'success' | 'failure' | 'denied',
    backend: Backend,
    metadata: Record<string, string | number | boolean>,
  ): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: this.actor.type,
      ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
      action,
      targetType: 'backend',
      targetId: backend.id,
      result,
      // Flat primitives only: never the connection config, env values, or headers.
      metadata,
      createdAt: this.now(),
    });
  }

  /** Security-relevant: repeated invalid configs can be an attempt to probe the API. */
  private auditValidationFailure(reason: string, paths: string[]): void {
    this.store.audit.append({
      id: randomUUID(),
      actorType: this.actor.type,
      ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
      // No target: nothing was persisted, so there is no entity to point at.
      action: 'backend.validation_failed',
      result: 'failure',
      metadata: { operation: 'validate', reason, fields: paths.slice(0, 20).join(',') },
      createdAt: this.now(),
    });
  }

  private now(): string {
    return new Date().toISOString();
  }
}

/**
 * Public representation of a backend.
 *
 * Today `config_json` stores secret *references*, not values, so the stored
 * config is already safe. This function still copies rather than passing the
 * entity through, so a future secret-valued field cannot leak by default: it has
 * to be added here deliberately.
 */
export function toPublicBackend(backend: BackendListItem): Record<string, unknown> {
  return {
    id: backend.id,
    name: backend.name,
    ...(backend.description === undefined ? {} : { description: backend.description }),
    transport: backend.connection.type,
    connection: { ...backend.connection },
    enabled: backend.enabled,
    timeoutMs: backend.timeoutMs,
    concurrencyMode: backend.concurrencyMode,
    ...(backend.concurrencyLimit === undefined ? {} : { concurrencyLimit: backend.concurrencyLimit }),
    version: backend.version,
    createdAt: backend.createdAt,
    updatedAt: backend.updatedAt,
    ...(backend.runtime === undefined ? {} : { runtime: backend.runtime }),
  };
}

/** Normalised config for a validate response: references are shown, values never exist. */
function redactConnectionForDisplay(input: {
  connection: { type: string } & Record<string, unknown>;
  timeoutMs: number;
  concurrencyMode: string;
  concurrencyLimit?: number;
  enabled: boolean;
}): Record<string, unknown> {
  return {
    transport: input.connection.type,
    connection: { ...input.connection },
    timeoutMs: input.timeoutMs,
    concurrencyMode: input.concurrencyMode,
    ...(input.concurrencyLimit === undefined ? {} : { concurrencyLimit: input.concurrencyLimit }),
    enabled: input.enabled,
  };
}

function changedFields(before: Backend, after: Backend): string[] {
  const fields: Array<keyof Backend> = [
    'name',
    'description',
    'connection',
    'enabled',
    'timeoutMs',
    'concurrencyMode',
    'concurrencyLimit',
  ];

  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
