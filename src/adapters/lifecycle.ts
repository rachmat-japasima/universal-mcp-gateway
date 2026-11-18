import { randomUUID } from 'node:crypto';

import type { Backend } from '../domain/backend.js';
import type { BackendRuntime, BackendStatus } from '../domain/backend-runtime.js';
import { canTransition, initialBackendRuntime } from '../domain/backend-runtime.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AppError } from '../shared/errors.js';
import type { BackendAdapter } from '../adapters/adapter.js';
import { createAdapter } from '../adapters/adapter.js';
import type { McpBackendClient } from '../adapters/mcp-client.js';
import type { DestinationPolicy } from '../security/network-policy.js';
import { assertDestination } from '../security/network-policy.js';

/**
 * Backend lifecycle manager.
 *
 * The single owner of live connections. Configuration lives in SQLite; live
 * objects live here and never in a database row. The invariants it exists to
 * guarantee:
 *
 *   * one runtime per backend id — a second `connect()` is answered, not raced;
 *   * operations on one backend are serialized, so two concurrent HTTP requests
 *     cannot interleave state transitions;
 *   * every persisted transition is legal (`canTransition`), so a stored status
 *     is always reachable from its predecessor;
 *   * teardown happens in `close`, `disable`, delete, update-of-connection-fields,
 *     and shutdown — there is no path that drops the in-memory entry but leaves
 *     a child process running;
 *   * nothing auto-connects: not on create, not on enable, not at startup.
 *
 * Concurrency model: one promise chain per backend. It is the smallest thing
 * that serializes in a single-process Node service, and it needs no lock table,
 * no timeout, and no deadlock analysis. Different backends proceed in parallel.
 */

export interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Fraction of the delay used as ± jitter, 0–1. */
  jitterRatio: number;
}

export interface LifecycleOptions {
  store: Database;
  logger: Logger;
  networkPolicy: DestinationPolicy;
  reconnect: ReconnectPolicy;
  /** Injected so tests can run with a deterministic clock and no waiting. */
  now?: () => string;
  /** Injected so tests can observe backoff without sleeping. */
  random?: () => number;
}

/** Emitted once per successful open and once per teardown that released a client. */
export interface ConnectionChangeEvent {
  backendId: string;
  type: 'opened' | 'closed';
  /** Present on `closed` so the observer can say why. */
  reason?: string;
}

/** Public runtime view. Deliberately excludes pids, handles, and connection config. */
export interface RuntimeView {
  backendId: string;
  status: BackendStatus;
  lastConnectedAt?: string;
  lastHealthCheckAt?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  reconnectAttempts: number;
  /** Present only while a connection is actually live. */
  uptimeMs?: number;
  updatedAt: string;
}

interface Entry {
  backendId: string;
  runtime: BackendRuntime;
  adapter?: BackendAdapter;
  client?: McpBackendClient;
  /** Connection-relevant config hash; a change invalidates the runtime. */
  fingerprint: string;
  connectedAt?: number;
  /** Pending reconnect timer, cancelled by disable/delete/shutdown/close. */
  timer?: NodeJS.Timeout;
  /** Serializes operations for this backend. */
  queue: Promise<unknown>;
}

/** Fields whose change makes a live connection describe the wrong thing. */
function fingerprintOf(backend: Backend): string {
  return JSON.stringify({
    connection: backend.connection,
    timeoutMs: backend.timeoutMs,
    enabled: backend.enabled,
  });
}

/** A failure worth retrying: the peer was absent or slow, not misconfigured. */
function isTransient(error: AppError): boolean {
  return error.code === 'BACKEND_TIMEOUT' || error.code === 'BACKEND_UNAVAILABLE';
}

export class BackendLifecycleManager {
  private readonly entries = new Map<string, Entry>();
  private readonly store: Database;
  private readonly logger: Logger;
  private readonly networkPolicy: DestinationPolicy;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly now: () => string;
  private readonly random: () => number;
  /** Set by the owner after construction, so discovery can follow the runtime. */
  private connectionObserver: (event: ConnectionChangeEvent) => void = () => undefined;
  private shuttingDown = false;

  constructor(options: LifecycleOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.networkPolicy = options.networkPolicy;
    this.reconnectPolicy = options.reconnect;
    this.now = options.now ?? (() => new Date().toISOString());
    this.random = options.random ?? Math.random;
  }

  /**
   * Registers the connection observer.
   *
   * A setter rather than a constructor option because the two services are
   * mutually referential: discovery needs the lifecycle to find clients, and the
   * lifecycle needs discovery to follow connections. The setter breaks the cycle
   * without a lazy accessor or a second constructor argument.
   */
  setConnectionObserver(observer: (event: ConnectionChangeEvent) => void): void {
    this.connectionObserver = observer;
  }

  // ---------------------------------------------------------------- startup

  /**
   * Reconciles persisted runtime rows with reality after a process restart.
   *
   * A persisted `connected` is a claim by a process that no longer exists, so it
   * is never trusted. Every non-resting status is rewritten to `disconnected`
   * (or `disabled` when the configuration says so). Nothing reconnects: the
   * gateway must not dial the network because it was restarted.
   */
  recover(): { recovered: number; disconnected: number; disabled: number } {
    let recovered = 0;
    let disconnected = 0;
    let disabled = 0;

    for (const runtime of this.store.backendRuntime.list()) {
      const backend = this.store.backends.findById(runtime.backendId);

      if (backend === undefined) {
        // The configuration is tombstoned: keep the row, drop the claim.
        this.store.backendRuntime.upsert({
          ...runtime,
          status: 'disconnected',
          reconnectAttempts: 0,
          updatedAt: this.now(),
        });
        recovered += 1;
        continue;
      }

      const target: BackendStatus = backend.enabled ? 'disconnected' : 'disabled';
      if (!backend.enabled) disabled += 1;
      else disconnected += 1;

      // `error` also survives a restart as an error: the operator asked a
      // question and got a no. Only live-sounding states are rewritten.
      const keepError = runtime.status === 'error' && backend.enabled;

      this.store.backendRuntime.upsert({
        ...runtime,
        status: keepError ? 'error' : target,
        // Attempt counters belong to a reconnect sequence, not to the process.
        reconnectAttempts: 0,
        updatedAt: this.now(),
      });

      if (runtime.status !== target && !keepError) recovered += 1;
    }

    this.logger.info({ recovered, disconnected, disabled }, 'Backend runtime recovered to a safe state');
    return { recovered, disconnected, disabled };
  }

  // ------------------------------------------------------------- public API

  /**
   * Opens a connection. Idempotent under concurrency: a second call while a
   * connect is in flight waits for it and then reports the resulting state.
   */
  async connect(backendId: string, options: { requestId?: string } = {}): Promise<RuntimeView> {
    return this.serialize(backendId, async (entry) => {
      if (this.shuttingDown) throw new AppError('BACKEND_UNAVAILABLE', 'The gateway is shutting down.');
      if (entry.runtime.status === 'connected' || entry.runtime.status === 'connecting') return this.view(entry);

      if (entry.client !== undefined) {
        // A live client with a non-connected status is an inconsistency we
        // resolve rather than paper over.
        await this.teardown(entry, 'stale');
      }

      const backend = this.requireBackend(backendId);
      if (!backend.enabled) {
        throw new AppError('RESOURCE_CONFLICT', 'The backend is disabled; enable it before connecting.', {
          details: { backendId },
        });
      }

      await this.open(entry, backend, options.requestId);
      return this.view(entry);
    });
  }

  /** Idempotent: disconnecting an idle backend is a no-op, not an error. */
  async disconnect(backendId: string, options: { requestId?: string } = {}): Promise<RuntimeView> {
    return this.serialize(backendId, async (entry) => {
      this.cancelReconnect(entry);
      await this.teardown(entry, options.requestId ?? 'disconnect');

      if (entry.runtime.status !== 'disconnected' && entry.runtime.status !== 'disabled') {
        this.persist(entry, { status: 'disconnected' });
      }

      return this.view(entry);
    });
  }

  /** Explicit operator retry. Resets the attempt counter: this is a new sequence. */
  async reconnect(backendId: string, options: { requestId?: string } = {}): Promise<RuntimeView> {
    return this.serialize(backendId, async (entry) => {
      this.cancelReconnect(entry);
      await this.teardown(entry, options.requestId ?? 'reconnect');

      const backend = this.requireBackend(backendId);
      if (!backend.enabled) {
        throw new AppError('RESOURCE_CONFLICT', 'The backend is disabled; enable it before reconnecting.', {
          details: { backendId },
        });
      }

      if (entry.runtime.status !== 'disconnected') this.persist(entry, { status: 'disconnected' });
      this.persist(entry, { status: 'disconnected', reconnectAttempts: 0 });

      await this.open(entry, backend, options.requestId);
      return this.view(entry);
    });
  }

  /**
   * Brings the runtime in line with a configuration change.
   *
   * Called by the registry after a mutation commits. One method instead of five
   * change detectors: it reads the current row, compares a fingerprint, and
   * decides. Never connects — a configuration change is not permission to dial.
   */
  async reconcile(backendId: string, options: { requestId?: string } = {}): Promise<void> {
    await this.serialize(backendId, async (entry) => {
      const backend = this.store.backends.findById(backendId);

      if (backend === undefined) {
        // Tombstoned: stop everything and leave a truthful row behind.
        this.cancelReconnect(entry);
        await this.teardown(entry, options.requestId ?? 'deleted');
        this.persist(entry, { status: 'disconnected', reconnectAttempts: 0 });
        return;
      }

      if (!backend.enabled) {
        this.cancelReconnect(entry);
        await this.teardown(entry, options.requestId ?? 'disabled');
        if (entry.runtime.status !== 'disabled') {
          this.persist(entry, { status: 'disabled', reconnectAttempts: 0 });
        }
        return;
      }

      const fingerprint = fingerprintOf(backend);

      if (entry.adapter !== undefined && fingerprint !== entry.fingerprint) {
        // Connection fields moved under a live connection: the old runtime
        // describes a configuration that no longer exists.
        this.cancelReconnect(entry);
        await this.teardown(entry, options.requestId ?? 'configuration-changed');
        this.persist(entry, { status: 'disconnected', reconnectAttempts: 0 });
        entry.fingerprint = fingerprint;
        this.logger.info(
          { backendId, transport: backend.connection.type, state: 'disconnected' },
          'Backend runtime invalidated by configuration change',
        );
        return;
      }

      entry.fingerprint = fingerprint;

      // A disabled -> enabled flip must not leave `disabled` behind.
      if (entry.runtime.status === 'disabled') {
        this.persist(entry, { status: 'disconnected', reconnectAttempts: 0 });
      }
    });
  }

  getRuntimeState(backendId: string): RuntimeView {
    const backend = this.store.backends.findById(backendId);
    if (backend === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', { details: { backendId } });
    }

    const entry = this.entries.get(backendId);
    if (entry !== undefined) return this.view(entry);

    const stored = this.store.backendRuntime.findByBackendId(backendId);
    if (stored === undefined) {
      return { ...initialBackendRuntime(backendId, backend.enabled, this.now()) } as RuntimeView;
    }

    return toView(stored);
  }

  /** Every registered backend, whether or not it has ever been connected. */
  getAllRuntimeStates(): RuntimeView[] {
    return this.store.backends
      .list()
      .map((backend) => this.getRuntimeState(backend.id))
      .sort((a, b) => a.backendId.localeCompare(b.backendId));
  }

  /**
   * Stops every connection and cancels every pending retry.
   *
   * Idempotent and bounded: each teardown is already timeout-guarded by the
   * adapter, and all backends are torn down in parallel so one stuck child does
   * not serialize the rest of shutdown.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    const entries = [...this.entries.values()];
    await Promise.allSettled(
      entries.map((entry) =>
        this.serialize(entry.backendId, async (current) => {
          this.cancelReconnect(current);
          await this.teardown(current, 'shutdown');
          if (current.runtime.status !== 'disconnected' && current.runtime.status !== 'disabled') {
            this.persist(current, { status: 'disconnected' });
          }
        }),
      ),
    );

    this.entries.clear();
    this.logger.info({ backends: entries.length }, 'Backend lifecycle shut down');
  }

  // ------------------------------------------------------------- internals

  /** Opens a connection and records the outcome. Caller holds the lock. */
  private async open(entry: Entry, backend: Backend, requestId: string | undefined): Promise<void> {
    const transport = backend.connection.type;
    const startedAt = Date.now();

    this.logger.info({ backendId: backend.id, transport, requestId, state: 'connecting' }, 'Backend connection started');
    this.persist(entry, { status: 'connecting' });

    const adapter = createAdapter({
      backend,
      logger: this.logger,
      networkPolicy: this.networkPolicy,
      events: {
        onUnexpectedClose: (detail) => {
          // Fired from a transport callback, outside the queue: hop into it so
          // the transition cannot interleave with an operator action.
          void this.serialize(backend.id, async (current) => this.handleUnexpectedClose(current, detail)).catch(
            () => undefined,
          );
        },
      },
    });

    entry.adapter = adapter;
    entry.fingerprint = fingerprintOf(backend);

    try {
      entry.client = await adapter.connect();
    } catch (error) {
      const normalized = error instanceof AppError ? error : new AppError('BACKEND_CONNECTION_ERROR', 'Connection failed.');
      entry.adapter = undefined;
      entry.client = undefined;

      this.persist(entry, {
        status: 'error',
        lastErrorCode: normalized.code === 'BACKEND_TIMEOUT' ? 'BACKEND_TIMEOUT' : lastErrorCode(normalized),
        lastErrorAt: this.now(),
        lastErrorMessage: safeMessage(normalized),
      });

      this.logger.warn(
        {
          backendId: backend.id,
          transport,
          requestId,
          state: 'error',
          code: normalized.code,
          durationMs: Date.now() - startedAt,
        },
        'Backend connection failed',
      );

      // Permanent failures (bad executable, refused policy, unreachable host)
      // are not retried: the answer will not change without an edit.
      if (isTransient(normalized)) this.scheduleReconnect(entry, backend, requestId);

      throw normalized;
    }

    entry.connectedAt = Date.now();
    this.persist(entry, { status: 'connected', lastConnectedAt: this.now(), reconnectAttempts: 0 });

    this.logger.info(
      { backendId: backend.id, transport, requestId, state: 'connected', durationMs: Date.now() - startedAt },
      'Backend connected',
    );

    this.notify({ backendId: backend.id, type: 'opened' });
  }

  private async handleUnexpectedClose(entry: Entry, detail: string): Promise<void> {
    if (this.shuttingDown) return;
    if (entry.client === undefined) return;

    const backend = this.store.backends.findById(entry.backendId);
    const transport = entry.adapter?.transport;
    const connectedAt = entry.connectedAt;

    entry.client = undefined;
    entry.adapter = undefined;
    entry.connectedAt = undefined;

    this.logger.warn(
      {
        backendId: entry.backendId,
        transport,
        state: 'unhealthy',
        uptimeMs: connectedAt === undefined ? undefined : Date.now() - connectedAt,
      },
      'Backend connection lost',
    );

    this.notify({ backendId: entry.backendId, type: 'closed', reason: 'connection-lost' });

    if (entry.runtime.status === 'connected' || entry.runtime.status === 'disconnecting') {
      this.persist(entry, { status: 'unhealthy', lastErrorCode: 'BACKEND_UNAVAILABLE', lastErrorAt: this.now(), lastErrorMessage: detail });
    }

    if (backend === undefined || !backend.enabled) {
      this.persist(entry, { status: backend === undefined ? 'disconnected' : 'disabled' });
      return;
    }

    this.scheduleReconnect(entry, backend, undefined);
  }

  private scheduleReconnect(entry: Entry, backend: Backend, requestId: string | undefined): void {
    if (!this.reconnectPolicy.enabled || this.shuttingDown) return;

    const attempts = entry.runtime.reconnectAttempts + 1;
    if (attempts > this.reconnectPolicy.maxAttempts) {
      this.persist(entry, { status: 'error', reconnectAttempts: attempts - 1 });
      this.logger.warn(
        { backendId: backend.id, transport: backend.connection.type, attempts: attempts - 1, state: 'error' },
        'Backend reconnect attempts exhausted',
      );
      return;
    }

    const delay = this.backoffDelay(attempts);

    this.persist(entry, {
      status: entry.runtime.status === 'error' || entry.runtime.status === 'unhealthy' ? entry.runtime.status : 'error',
      reconnectAttempts: attempts,
      lastErrorCode: entry.runtime.lastErrorCode ?? 'BACKEND_UNAVAILABLE',
      lastErrorAt: entry.runtime.lastErrorAt ?? this.now(),
      lastErrorMessage: entry.runtime.lastErrorMessage ?? 'The connection was lost.',
    });

    this.cancelReconnect(entry);
    const timer = setTimeout(() => {
      entry.timer = undefined;
      void this.serialize(entry.backendId, async (current) => {
        if (this.shuttingDown) return;

        const latest = this.store.backends.findById(entry.backendId);
        // Cancellation is re-checked at fire time: the backend may have been
        // disabled or deleted during the wait.
        if (latest === undefined || !latest.enabled) {
          this.persist(current, { status: latest === undefined ? 'disconnected' : 'disabled' });
          return;
        }

        try {
          await this.open(current, latest, requestId);
        } catch {
          // `open` already recorded the failure and may have scheduled the next
          // attempt; a second schedule here would double the retry rate.
          this.logger.warn(
            { backendId: entry.backendId, transport: latest.connection.type, state: 'error' },
            'Backend reconnect failed',
          );
        }
      }).catch(() => undefined);
    }, delay);
    timer.unref?.();

    entry.timer = timer;

    this.logger.info(
      { backendId: backend.id, transport: backend.connection.type, attempts, delayMs: delay, state: entry.runtime.status },
      'Backend reconnect scheduled',
    );
  }

  /** Exponential, capped, jittered. Jitter is ±ratio so a fleet does not sync up. */
  private backoffDelay(attempt: number): number {
    const exponential = this.reconnectPolicy.initialDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.reconnectPolicy.maxDelayMs);
    const jitter = capped * this.reconnectPolicy.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  private cancelReconnect(entry: Entry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /**
   * Observer dispatch. Never awaited and never allowed to throw: the observer is
   * a catalog update, and a catalog bug must not unwind a connection attempt or
   * leave a teardown half-done.
   */
  private notify(event: ConnectionChangeEvent): void {
    try {
      this.connectionObserver(event);
    } catch (error) {
      this.logger.warn(
        { backendId: event.backendId, type: event.type, error: error instanceof Error ? error.name : 'unknown' },
        'Connection observer failed',
      );
    }
  }

  /** Terminal teardown. Caller holds the lock. */
  private async teardown(entry: Entry, reason: string): Promise<void> {
    const adapter = entry.adapter;
    if (adapter === undefined) {
      entry.client = undefined;
      entry.connectedAt = undefined;
      return;
    }

    const startedAt = Date.now();
    if (entry.runtime.status === 'connected' || entry.runtime.status === 'unhealthy') {
      this.persist(entry, { status: 'disconnecting' });
    }

    try {
      await adapter.close();
    } catch (error) {
      this.logger.warn(
        { backendId: entry.backendId, transport: adapter.transport, error: error instanceof Error ? error.name : 'unknown' },
        'Backend teardown reported an error',
      );
    }

    entry.adapter = undefined;
    entry.client = undefined;
    entry.connectedAt = undefined;

    if (entry.runtime.status === 'disconnecting') this.persist(entry, { status: 'disconnected' });

    this.logger.info(
      { backendId: entry.backendId, transport: adapter.transport, reason, durationMs: Date.now() - startedAt },
      'Backend disconnected',
    );

    this.notify({ backendId: entry.backendId, type: 'closed', reason });
  }

  /**
   * Writes a runtime row, enforcing the state machine.
   *
   * An illegal transition is a bug in this class, not a client error, so it
   * throws: silently persisting it would leave a status no predecessor can
   * explain.
   */
  private persist(entry: Entry, patch: Partial<BackendRuntime> & { status?: BackendStatus }): void {
    const current = entry.runtime;
    const next: BackendRuntime = { ...current, ...patch, backendId: entry.backendId, updatedAt: this.now() };

    if (patch.status !== undefined && patch.status !== current.status && !canTransition(current.status, patch.status)) {
      throw new AppError('INTERNAL_ERROR', 'Illegal backend runtime transition.', {
        details: { backendId: entry.backendId, from: current.status, to: patch.status },
      });
    }

    const stored = this.store.backendRuntime.upsert(next);
    entry.runtime = stored;
  }

  /** Reads the entry (creating one from storage) and serializes work on it. */
  private async serialize<T>(backendId: string, work: (entry: Entry) => Promise<T>): Promise<T> {
    const entry = this.entryFor(backendId);

    // Chain on the previous operation, then run. A rejection in one operation
    // must not break the chain for the next.
    const run = entry.queue.then(
      () => work(entry),
      () => work(entry),
    );

    entry.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private entryFor(backendId: string): Entry {
    const existing = this.entries.get(backendId);
    if (existing !== undefined) return existing;

    const stored = this.store.backendRuntime.findByBackendId(backendId);
    const backend = this.store.backends.findById(backendId);

    const runtime =
      stored ?? initialBackendRuntime(backendId, backend?.enabled ?? true, this.now());

    const entry: Entry = {
      backendId,
      runtime,
      fingerprint: backend === undefined ? '' : fingerprintOf(backend),
      queue: Promise.resolve(),
    };

    this.entries.set(backendId, entry);
    return entry;
  }

  private requireBackend(backendId: string): Backend {
    const backend = this.store.backends.findById(backendId);
    if (backend === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', { details: { backendId } });
    }
    return backend;
  }

  private view(entry: Entry): RuntimeView {
    const view = toView(entry.runtime);
    return entry.connectedAt === undefined ? view : { ...view, uptimeMs: Date.now() - entry.connectedAt };
  }

  /** Diagnostic only; used by tests and by shutdown logging. */
  get activeCount(): number {
    return [...this.entries.values()].filter((entry) => entry.adapter !== undefined).length;
  }

  /**
   * The live client for a backend, or `undefined` when there is none.
   *
   * This is the only hand-off from the lifecycle to the router. It is
   * deliberately a *lookup at call time*, not a cached reference: a client held
   * across a disconnect would be a stale mapping, and the whole point of the
   * catalog is that a call cannot outlive its connection.
   *
   * Gated on `connected`: `unhealthy` means the transport reported a loss and a
   * reconnect may be pending, so it is not a safe moment to hand out a client.
   */
  activeClient(backendId: string): McpBackendClient | undefined {
    const entry = this.entries.get(backendId);
    if (entry === undefined) return undefined;
    if (entry.runtime.status !== 'connected') return undefined;
    return entry.client;
  }

  /** True when `activeClient` would return a client. Cheaper for listing. */
  isConnected(backendId: string): boolean {
    const entry = this.entries.get(backendId);
    return entry !== undefined && entry.runtime.status === 'connected' && entry.client !== undefined;
  }

  /** A random id for logs emitted outside a request. */
  static requestId(): string {
    return randomUUID();
  }
}

function toView(runtime: BackendRuntime): RuntimeView {
  return {
    backendId: runtime.backendId,
    status: runtime.status,
    ...(runtime.lastConnectedAt === undefined ? {} : { lastConnectedAt: runtime.lastConnectedAt }),
    ...(runtime.lastHealthCheckAt === undefined ? {} : { lastHealthCheckAt: runtime.lastHealthCheckAt }),
    ...(runtime.lastErrorCode === undefined ? {} : { lastErrorCode: runtime.lastErrorCode }),
    ...(runtime.lastErrorAt === undefined ? {} : { lastErrorAt: runtime.lastErrorAt }),
    ...(runtime.lastErrorMessage === undefined ? {} : { lastErrorMessage: runtime.lastErrorMessage }),
    reconnectAttempts: runtime.reconnectAttempts,
    updatedAt: runtime.updatedAt,
  };
}

/** Only the three codes the runtime column accepts. */
function lastErrorCode(error: AppError): 'BACKEND_CONNECTION_ERROR' | 'BACKEND_TIMEOUT' | 'BACKEND_UNAVAILABLE' {
  if (error.code === 'BACKEND_TIMEOUT') return 'BACKEND_TIMEOUT';
  if (error.code === 'BACKEND_UNAVAILABLE') return 'BACKEND_UNAVAILABLE';
  return 'BACKEND_CONNECTION_ERROR';
}

/**
 * A display-safe failure message.
 *
 * `AppError.message` is already written for a client, but an adapter can add a
 * sanitized stderr line, so the length is bounded here as the column requires.
 */
function safeMessage(error: AppError): string {
  return error.message.slice(0, 500);
}

/** Validates a destination without opening a connection. Exposed for operators. */
export async function validateDestination(url: string, policy: DestinationPolicy): Promise<void> {
  await assertDestination(url, policy);
}
