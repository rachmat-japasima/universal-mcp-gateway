import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request correlation context (Phase 11).
 *
 * Three identifiers, deliberately distinct:
 *
 *   * `requestId` — one HTTP exchange. Generated per request, echoed as
 *     `X-Request-Id`, persisted on activity and audit rows as the exchange key.
 *   * `correlationId` — a client-supplied (validated) or generated id that
 *     groups related operations across the execution pipeline. Unlike
 *     `requestId` it may span several requests (a client task that makes three
 *     MCP calls), which is exactly what `X-Correlation-Id` is for.
 *   * MCP session id — a protocol routing handle bound to an agent row. It is
 *     *not* an authentication credential and is never treated as one
 *     (`docs/SECURITY.md`).
 *
 * The store lives in `AsyncLocalStorage`, so concurrent requests each get their
 * own object and nothing is globally mutable: a field exists only inside the
 * async subtree of the request that set it, and a rejection cannot leak it to
 * the next request. Background work (reconnect timers, transport callbacks)
 * runs outside any request context; helpers answer `undefined` there and call
 * sites omit the fields rather than fabricate them.
 */

export interface CorrelationContext {
  requestId: string;
  correlationId: string;
  /** Enriched mid-request as identity is established. Never fabricated. */
  agentId?: string;
  credentialId?: string;
  /** MCP protocol session id, when one has been resolved. */
  sessionId?: string;
  backendId?: string;
  /** Managed-integration connection id. Mutually exclusive with `backendId` by construction (ADR-048). */
  connectionId?: string;
  /** Public tool name (the catalog's namespaced name, never raw arguments). */
  toolId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Runs one request's handler chain inside its own correlation context. */
export function runWithCorrelation<T>(context: CorrelationContext, run: () => Promise<T>): Promise<T> {
  return storage.run(context, run);
}

/** The current request's context, or `undefined` outside a request. */
export function correlationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/**
 * Adds known fields to the current request's context. A no-op outside a request
 * (background work has no context to enrich), and empty values are ignored so
 * a field can never hold `''`.
 */
export function enrichCorrelation(fields: Partial<CorrelationContext>): void {
  const store = storage.getStore();
  if (store === undefined) return;

  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value !== '') Object.assign(store, { [key]: value });
  }
}

/**
 * The two ids every correlatable log line should carry. Returned only when a
 * context exists, so a log site can spread it without emitting `undefined`.
 */
export function correlationLogFields(): { requestId?: string; correlationId?: string } {
  const store = storage.getStore();
  return store === undefined ? {} : { requestId: store.requestId, correlationId: store.correlationId };
}
