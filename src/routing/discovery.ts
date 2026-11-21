import { randomUUID } from 'node:crypto';

import type { ActivityType } from '../domain/activity-event.js';
import type { Backend } from '../domain/backend.js';
import type { DiscoveryReport, ToolDefinition } from '../domain/tool.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { correlationContext } from '../monitoring/context.js';
import { AppError, describeErrorForLog } from '../shared/errors.js';
import { backendSource } from '../integrations/source.js';
import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import type { McpBackendClient } from '../adapters/mcp-client.js';
import { normalizeMcpError } from '../adapters/mcp-client.js';
import { buildTools, ToolCatalog, type DiscoveryOutcome } from './catalog.js';

/**
 * Tool discovery.
 *
 * Owns the only path that turns a live connection into catalog records, and the
 * only path that removes them. Everything it writes is validated here, so the
 * catalog can assume its input is already sane.
 *
 * Concurrency model, deliberately narrow (Phase 7 owns real locking):
 *
 *  - discovery for a backend is coalesced: a second request while one is running
 *    joins the first instead of double-listing a backend;
 *  - a discovery result is discarded if the backend disconnected or was
 *    reconfigured while the list was in flight, so a snapshot can never describe
 *    a connection that no longer exists;
 *  - different backends discover in parallel.
 */

export interface DiscoveryOptions {
  store: Database;
  logger: Logger;
  lifecycle: BackendLifecycleManager;
  catalog: ToolCatalog;
  /** Injected so a test can pin timestamps. */
  now?: () => string;
  /**
   * Upper bound for one `listTools()` call. Separate from the backend's own
   * per-call timeout because discovery happens during connect, where a slow list
   * must not make a healthy backend look dead.
   */
  timeoutMs?: number;
}

export interface RefreshResult {
  backendId: string;
  ok: boolean;
  report?: DiscoveryReport;
  /** Present when discovery failed; safe to return to an operator. */
  error?: AppError;
}

/** Sanity limits. A backend that exceeds them is broken, not merely large. */
const MAX_TOOLS = 2_000;
const MAX_SCHEMA_BYTES = 256 * 1024;

export class ToolDiscovery {
  private readonly store: Database;
  private readonly logger: Logger;
  private readonly lifecycle: BackendLifecycleManager;
  private readonly catalog: ToolCatalog;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  /** In-flight discovery per backend, so concurrent refreshes share one list call. */
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();

  constructor(options: DiscoveryOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.lifecycle = options.lifecycle;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Discovers one backend. Coalesced: callers that arrive during a run get that
   * run's result, which is the answer they would have computed anyway.
   */
  async discover(backendId: string, options: { requestId?: string } = {}): Promise<RefreshResult> {
    const running = this.inFlight.get(backendId);
    if (running !== undefined) return running;

    const attempt = this.run(backendId, options.requestId).finally(() => {
      this.inFlight.delete(backendId);
    });

    this.inFlight.set(backendId, attempt);
    return attempt;
  }

  /** Every backend that is currently connected and enabled. Sequential per backend, parallel across. */
  async discoverAll(options: { requestId?: string } = {}): Promise<RefreshResult[]> {
    const eligible = this.store.backends
      .list()
      .filter((backend) => backend.enabled && this.lifecycle.isConnected(backend.id))
      .map((backend) => backend.id);

    return Promise.all(eligible.map((backendId) => this.discover(backendId, options)));
  }

  /**
   * Removes a backend's tools. Called on disconnect, disable and delete — the
   * single answer to "this backend's tools must stop being callable now".
   */
  invalidate(backendId: string, reason: string, options: { requestId?: string } = {}): void {
    const removed = this.catalog.remove(backendSource(backendId));
    if (!removed) return;

    this.logger.info({ backendId, reason, requestId: options.requestId }, 'Tool catalog entry removed');
    this.record('tools.list', 'success', {
      backendId,
      requestId: options.requestId,
      errorCode: undefined,
      durationMs: undefined,
    });
  }

  /**
   * The lifecycle observer. Bound once at construction so a connection change
   * cannot be missed between two polls.
   */
  readonly onConnectionChange = (event: { backendId: string; type: 'opened' | 'closed'; reason?: string }): void => {
    if (event.type === 'closed') {
      this.invalidate(event.backendId, event.reason ?? 'disconnected');
      return;
    }

    // Fire-and-forget: the connect call has already returned to the operator,
    // and a discovery failure must not be reported as a connection failure.
    void this.discover(event.backendId).catch(() => undefined);
  };

  private async run(backendId: string, requestId: string | undefined): Promise<RefreshResult> {
    const backend = this.store.backends.findById(backendId);
    if (backend === undefined) {
      return { backendId, ok: false, error: new AppError('RESOURCE_NOT_FOUND', 'The backend does not exist.') };
    }

    if (!backend.enabled) {
      return { backendId, ok: false, error: new AppError('RESOURCE_CONFLICT', 'The backend is disabled.') };
    }

    const client = this.lifecycle.activeClient(backendId);
    if (client === undefined) {
      return { backendId, ok: false, error: new AppError('BACKEND_UNAVAILABLE', 'The backend is not connected.') };
    }

    const startedAt = Date.now();
    this.logger.info({ backendId, requestId }, 'Tool discovery started');

    const raw = await this.listTools(client, backend, backendId, startedAt, requestId);
    if ('error' in raw) return raw.error;

    const { tools, rejected } = buildTools({ backendId, now: this.now(), tools: raw.tools, rejected: raw.rejected });

    // A disconnect during discovery invalidates this result: the snapshot would
    // describe a connection that is gone. Dropping is correct, not merely safe.
    if (!this.lifecycle.isConnected(backendId) || this.store.backends.findById(backendId) === undefined) {
      this.logger.info({ backendId, requestId, reason: 'connection-changed' }, 'Tool discovery discarded');
      return {
        backendId,
        ok: false,
        error: new AppError('BACKEND_UNAVAILABLE', 'The backend disconnected during discovery.'),
      };
    }

    const snapshot = {
      sourceType: 'mcp_backend' as const,
      sourceId: backendId,
      tools,
      report: {
        backendId,
        status: 'ok' as const,
        toolCount: tools.size,
        // Baseline only: the catalog computes the live count at read time,
        // because a conflict is a property of the whole catalog, not of this
        // backend's discovery.
        conflictCount: 0,
        rejectedCount: rejected.length,
        discoveredAt: this.now(),
      },
    };

    const outcome = this.catalog.replace(snapshot);

    this.logger.info(
      {
        backendId,
        requestId,
        tools: tools.size,
        added: outcome.added.length,
        removed: outcome.removed.length,
        changed: outcome.changed.length,
        rejected: rejected.length,
        durationMs: Date.now() - startedAt,
      },
      'Tool discovery completed',
    );

    this.record('tools.list', 'success', {
      backendId,
      requestId,
      errorCode: undefined,
      durationMs: Date.now() - startedAt,
    });

    this.reportConflicts(outcome, requestId);

    return { backendId, ok: true, report: this.catalog.reportFor(backendId) };
  }

  private async listTools(
    client: McpBackendClient,
    backend: Backend,
    backendId: string,
    startedAt: number,
    requestId: string | undefined,
  ): Promise<{ tools: ToolDefinition[]; rejected: string[] } | { error: RefreshResult }> {
    let listed: unknown[];
    try {
      listed = await withDeadline(() => client.listTools(), Math.min(this.timeoutMs, backend.timeoutMs));
    } catch (error) {
      const normalized = normalizeMcpError(error, 'Tool discovery failed');
      this.logger.warn(
        { backendId, requestId, code: normalized.code, durationMs: Date.now() - startedAt },
        'Tool discovery failed',
      );
      this.record('tools.list', 'failure', {
        backendId,
        requestId,
        errorCode: normalized.code,
        durationMs: Date.now() - startedAt,
      });
      return { error: { backendId, ok: false, error: normalized } };
    }

    const tools: ToolDefinition[] = [];
    const rejected: string[] = [];

    if (listed.length > MAX_TOOLS) {
      const error = new AppError('VALIDATION_ERROR', `The backend advertised more than ${MAX_TOOLS} tools.`);
      this.logger.warn({ backendId, requestId, count: listed.length }, 'Tool discovery rejected');
      return { error: { backendId, ok: false, error } };
    }

    for (const candidate of listed) {
      const parsed = toDefinition(candidate);
      if (parsed === undefined) {
        rejected.push(describeCandidate(candidate));
        continue;
      }
      if (schemaBytes(parsed.inputSchema) > MAX_SCHEMA_BYTES) {
        rejected.push(parsed.name.slice(0, 200));
        continue;
      }
      tools.push(parsed);
    }

    if (rejected.length > 0) {
      // Names only — a malformed tool can carry arbitrary strings, so the
      // count is logged and the identifiers go no further than the report.
      this.logger.warn({ backendId, requestId, rejected: rejected.length }, 'Backend tools rejected during discovery');
    }

    return { tools, rejected };
  }

  /**
   * Conflict counts are catalog-wide, so a report read through the catalog
   * always reflects the current index. This only logs the ones that appeared
   * because of *this* discovery.
   */
  private reportConflicts(outcome: DiscoveryOutcome, requestId: string | undefined): void {
    const conflicts = this.catalog.conflicts$();
    const affected = conflicts.filter((conflict) =>
      conflict.claimants.some((claimant) => outcome.report.backendId === claimant.backendId),
    );

    for (const conflict of affected) {
      this.logger.error(
        {
          publicName: conflict.publicName,
          claimants: conflict.claimants.map((claimant) => claimant.backendId),
          requestId,
        },
        'Tool name collision: both tools withheld',
      );
      this.record('tools.list', 'failure', {
        backendId: outcome.report.backendId,
        requestId,
        toolName: conflict.publicName,
        errorCode: 'RESOURCE_CONFLICT',
        durationMs: undefined,
      });
    }
  }

  /** Activity rows are best effort: a database failure must not fail a call. */
  private record(
    type: ActivityType,
    outcome: 'success' | 'failure',
    fields: {
      backendId?: string;
      requestId?: string;
      toolName?: string;
      errorCode?: string;
      durationMs?: number;
    },
  ): void {
    try {
      // Present when the discovery was triggered by a request; absent when it
      // follows a background connection change. Omitted, never fabricated.
      const correlationId = correlationContext()?.correlationId;

      this.store.activity.append({
        id: randomUUID(),
        type,
        outcome,
        createdAt: this.now(),
        ...(fields.backendId === undefined ? {} : { backendId: fields.backendId }),
        ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(fields.toolName === undefined ? {} : { toolName: fields.toolName }),
        ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode }),
        ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
      });
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Activity event could not be recorded');
    }
  }
}

/** Narrows an SDK tool to the fields the catalog keeps, preserving unknown keys. */
export function toDefinition(candidate: unknown): ToolDefinition | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const record = candidate as Record<string, unknown>;

  const name = record['name'];
  if (typeof name !== 'string' || name.trim() === '') return undefined;

  const inputSchema = record['inputSchema'];
  // MCP requires an object schema. A backend that omits or mistypes it is
  // rejected rather than advertised with a substitute schema.
  if (!isObjectSchema(inputSchema)) return undefined;

  const definition: ToolDefinition = { name, inputSchema };

  if (typeof record['title'] === 'string') definition.title = record['title'];
  if (typeof record['description'] === 'string') definition.description = record['description'];
  if (isPlainObject(record['outputSchema'])) definition.outputSchema = record['outputSchema'];
  if (isPlainObject(record['annotations'])) definition.annotations = record['annotations'];
  if (isPlainObject(record['execution'])) definition.execution = record['execution'];
  if (isPlainObject(record['_meta'])) definition._meta = record['_meta'];
  if (Array.isArray(record['icons'])) definition.icons = record['icons'];

  return definition;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return value['type'] === undefined || value['type'] === 'object';
}

function schemaBytes(schema: Record<string, unknown>): number {
  try {
    return JSON.stringify(schema).length;
  } catch {
    // A cyclic or unserializable schema cannot be advertised either.
    return Number.POSITIVE_INFINITY;
  }
}

function describeCandidate(candidate: unknown): string {
  if (candidate !== null && typeof candidate === 'object') {
    const name = (candidate as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name.slice(0, 200);
  }
  return '(unnamed tool)';
}

/** Hard deadline on a promise whose work cannot be cancelled. See `withTimeout` in mcp-client. */
async function withDeadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AppError('BACKEND_TIMEOUT', 'Tool discovery timed out.')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
