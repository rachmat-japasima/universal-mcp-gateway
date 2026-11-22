import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { AppError } from '../shared/errors.js';
import { assertDestination, guardedFetch } from '../security/network-policy.js';
import type { AdapterContext, BackendAdapter } from './adapter.js';
import { resolveFromProcessEnv, resolveSecretRefs } from './adapter.js';
import { McpBackendClient, normalizeMcpError } from './mcp-client.js';

/**
 * Streamable HTTP transport.
 *
 * Security decisions, all enforced here and in `security/network-policy.ts`:
 *   * the destination is resolved and classified before any socket opens, so a
 *     URL that appears public but resolves to loopback/metadata is refused;
 *   * `fetch` is replaced by a guarded one, so every request the transport makes
 *     — including each redirect hop — is re-checked. Redirects are left on the
 *     SDK default `'same-origin'`, which fails a cross-origin hop outright
 *     rather than silently following it to a new destination;
 *   * TLS verification is never disabled: no agent, no `NODE_TLS_REJECT_UNAUTHORIZED`,
 *     no `rejectUnauthorized: false` anywhere in this codebase;
 *   * headers come from secret references and are passed to the transport. They
 *     are never logged, never persisted, and never attached to an error;
 *   * the gateway never forwards its own credentials: it has none to forward
 *     (the management API is unauthenticated and loopback-only), and the client
 *     info carries no token.
 *
 * Reconnection inside the SDK is disabled (`maxRetries: 0`): reconnection is a
 * lifecycle decision with backoff, cancellation, and persistence, so it belongs
 * to the lifecycle manager and not to a hidden timer inside the transport.
 */

export function createHttpAdapter(context: AdapterContext): BackendAdapter {
  const { backend, events, logger, networkPolicy } = context;
  const connection = backend.connection;

  if (connection.type !== 'streamable-http') {
    throw new AppError('CONFIGURATION_ERROR', 'Wrong adapter for this transport.');
  }

  let transport: StreamableHTTPClientTransport | undefined;
  let client: McpBackendClient | undefined;
  let closedByPeer = false;
  let closing = false;

  /**
   * Log/display form of the target. Credentials are structurally impossible in
   * a stored URL (the schema and the policy both reject them), but the query
   * string is dropped anyway: some servers put a token there.
   */
  const redacted = new URL(connection.url);
  redacted.search = '';
  redacted.hash = '';
  const target = redacted.href;

  return {
    transport: 'streamable-http',
    target,

    get closedByPeer() {
      return closedByPeer;
    },

    get pid() {
      return undefined;
    },

    async connect() {
      const url = await assertDestination(connection.url, networkPolicy);

      let headers: Record<string, string>;
      try {
        headers = resolveSecretRefs(connection.headers, resolveFromProcessEnv);
      } catch (error) {
        throw new AppError('CONFIGURATION_ERROR', 'A configured secret reference could not be resolved.', {
          cause: error,
          details: { backendId: backend.id },
        });
      }

      transport = new StreamableHTTPClientTransport(url, {
        // Undefined when there are no headers: passing `{}` would still install
        // an empty RequestInit, which is harmless but misleading in a trace.
        ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
        fetch: guardedFetch(networkPolicy),
        // Never 'follow': a redirect to another origin must fail, not be obeyed.
        redirectPolicy: 'same-origin',
        reconnectionOptions: {
          initialReconnectionDelay: 1_000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      });

      transport.onerror = (error) => {
        logger.warn(
          { backendId: backend.id, transport: 'streamable-http', error: error.name },
          'streamable HTTP transport reported an error',
        );
      };

      transport.onclose = () => {
        if (closing) return;
        closedByPeer = true;
        events.onUnexpectedClose('the HTTP connection closed');
      };

      client = new McpBackendClient({ timeoutMs: backend.timeoutMs });

      try {
        await client.connect(transport);
      } catch (error) {
        await this.close();
        throw normalizeMcpError(error, 'The backend could not be reached');
      }

      return client;
    },

    async close() {
      closing = true;

      // Ask the server to drop the session before we drop the socket. A server
      // that does not support it answers 405; that is not a failure.
      try {
        await transport?.terminateSession();
      } catch {
        // Best effort by design.
      }

      try {
        await client?.close();
      } catch {
        // Already closed.
      }

      try {
        await transport?.close();
      } catch {
        // Already closed.
      }

      client = undefined;
      transport = undefined;
    },
  };
}
