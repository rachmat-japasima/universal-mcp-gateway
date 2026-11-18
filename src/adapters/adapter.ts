import type { Backend, BackendConnection } from '../domain/backend.js';
import type { Logger } from '../monitoring/logger.js';
import type { DestinationPolicy } from '../security/network-policy.js';
import type { McpBackendClient } from './mcp-client.js';
import { createHttpAdapter } from './http-adapter.js';
import { createStdioAdapter } from './stdio-adapter.js';

/**
 * Transport adapter contract.
 *
 * An adapter owns exactly one thing that differs per transport: how a client is
 * built and how that client's resources are released. Everything else —
 * state transitions, retries, concurrency, persistence, logging — lives in the
 * lifecycle manager. A new transport is therefore one new factory case plus one
 * new file, and no change to the manager.
 *
 * Adapters are single-use: one backend, one connection attempt, one teardown.
 */
export interface BackendAdapter {
  readonly transport: BackendConnection['type'];
  /** Loggable target: an absolute path or a URL with credentials stripped. Never a secret. */
  readonly target: string;

  /**
   * Builds the transport, starts it, and initializes the MCP session.
   *
   * Throws `AppError` — never a raw SDK error — so the manager can record a
   * normalized code without inspecting the SDK.
   */
  connect(): Promise<McpBackendClient>;

  /** Releases every owned resource. Must be safe to call twice and after a failed connect. */
  close(): Promise<void>;

  /** True once the transport has signalled closure on its own (crash, EOF, network loss). */
  readonly closedByPeer: boolean;

  /** OS pid for stdio children; `undefined` for HTTP. Never exposed through the API. */
  readonly pid: number | undefined;
}

export interface AdapterEvents {
  /** The transport closed without `close()` being called: a crash, EOF, or dropped connection. */
  onUnexpectedClose: (detail: string) => void;
}

export interface AdapterContext {
  backend: Backend;
  events: AdapterEvents;
  logger: Logger;
  networkPolicy: DestinationPolicy;
}

/**
 * Resolves `secret:`/`env:` references to values.
 *
 * Phase 4 has no secret store yet (Phase 6), so only `env:` can be resolved.
 * A `secret:` reference fails loudly instead of being sent literally: sending
 * the string `secret:foo` as an API key would look like an auth failure and
 * would hide the real problem.
 *
 * The returned map is passed straight to the transport and is never logged,
 * persisted, or attached to an error.
 */
export function resolveSecretRefs(
  refs: Record<string, string>,
  resolve: (reference: string) => string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [name, reference] of Object.entries(refs)) {
    const value = resolve(reference);
    if (value === undefined) {
      // The reference itself is not a secret (it is a name), but the value is
      // absent, so only the variable name is mentioned.
      throw new Error(`Secret reference for "${name}" could not be resolved.`);
    }
    values[name] = value;
  }

  return values;
}

/** Environment references are read from this process; anything else needs the secret store. */
export function resolveFromProcessEnv(reference: string): string | undefined {
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice('env:'.length)];
    return value === undefined || value === '' ? undefined : value;
  }

  return undefined;
}

export function createAdapter(context: AdapterContext): BackendAdapter {
  switch (context.backend.connection.type) {
    case 'stdio':
      return createStdioAdapter(context);
    case 'streamable-http':
      return createHttpAdapter(context);
  }
}
