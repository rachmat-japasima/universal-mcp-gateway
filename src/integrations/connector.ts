import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ToolDefinition } from '../domain/tool.js';

/**
 * The connector contract (ADR-049).
 *
 * A connector is the only code allowed to talk to a managed provider. The
 * contract is deliberately *narrow* — everything a connector needs is a
 * parameter, so the gateway can prove by construction:
 *
 *  * no database handle: persistence stays behind the gateway's repositories.
 *  * no agent or operator credentials: the connector receives only the
 *    connection's own credential, resolved by the gateway.
 *  * credentials only via the resolver: a connector can ask "give me the
 *    value for this reference" and can never see where it came from, and
 *    the gateway can log the *event* without logging the value.
 *
 * Discovery and execution are separate methods on purpose: a connection can
 * be list-only (`discovery` capability without `execution`), and a call must
 * never trigger an implicit re-discovery.
 */

/** Normalized credential resolution. Backend-only; never logged, never cached by the caller. */
export type CredentialResolver = (credentialId: string) => Promise<string>;

/**
 * Everything a connector needs to act, and nothing more. The gateway builds
 * it per operation; connectors never construct one themselves.
 */
export interface ConnectorContext {
  /** Connection id — for logging and provider-side scoping only. */
  connectionId: string;
  /** Non-secret connection settings, already validated at the connection boundary. */
  metadata: Record<string, unknown>;
  /** Resolves the connection's stored credential reference to its value. */
  resolveCredential: CredentialResolver;
  /** Upper bound for one connector operation. The gateway enforces it with the signal. */
  timeoutMs: number;
  /** Cancelled by the gateway on timeout or client cancellation. */
  signal: AbortSignal;
}

/** Normalized connector outcome: success, a value, or a typed failure. */
export type ConnectorResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectorError };

/**
 * Failure taxonomy shared by every connector. `reauthorization_required`
 * maps to the connection status of the same name — the only error that
 * permanently stops the connection rather than failing one call.
 */
export const CONNECTOR_ERROR_KINDS = [
  'timeout',
  'unreachable',
  'invalid_request',
  'reauthorization_required',
  'provider_error',
] as const;
export type ConnectorErrorKind = (typeof CONNECTOR_ERROR_KINDS)[number];

export interface ConnectorError {
  kind: ConnectorErrorKind;
  /** Safe for operator logs; never includes credential material. */
  message: string;
}

/**
 * Tool discovery for one connection. Returns provider tool definitions in
 * the same shape discovery uses for backends; the gateway namespaces them.
 */
export type DiscoverTools = (context: ConnectorContext) => Promise<ConnectorResult<ToolDefinition[]>>;

/** Executes one already-namespaced tool call. Arguments are opaque to the gateway. */
export type ExecuteTool = (
  context: ConnectorContext,
  toolName: string,
  args: unknown,
) => Promise<ConnectorResult<CallToolResult>>;

/** The contract a provider implementation fulfills. Both halves optional per capabilities. */
export interface Connector {
  /** Executes when the provider declares `discovery`. */
  discoverTools?: DiscoverTools;
  /** Executes when the provider declares `execution`. */
  executeTool?: ExecuteTool;
}

/**
 * Wraps one connector operation with the context's timeout and signal so
 * every connector gets uniform timeout + cancellation without reimplementing
 * it. `ponytail:` no retry/backoff here — Phase 13 adds per-provider policy
 * if a real provider needs it.
 */
export async function withCancellation<T>(
  context: ConnectorContext,
  operation: () => Promise<ConnectorResult<T>>,
): Promise<ConnectorResult<T>> {
  return new Promise<ConnectorResult<T>>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: { kind: 'timeout', message: 'connector operation timed out' } });
    }, context.timeoutMs);

    const onAbort = () => {
      resolve({ ok: false, error: { kind: 'timeout', message: 'connector operation cancelled' } });
    };

    if (context.signal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    context.signal.addEventListener('abort', onAbort, { once: true });

    operation().then(
      (result) => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        resolve({
          ok: false,
          error: { kind: 'provider_error', message: cause instanceof Error ? cause.message : 'connector failed' },
        });
      },
    );
  });
}
