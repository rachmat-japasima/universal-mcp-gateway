import { randomBytes } from 'node:crypto';

import type { AuthInfo, Server } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import type { Agent } from '../domain/agent.js';
import type { AgentCredential } from '../domain/agent-credential.js';
import type { Logger } from '../monitoring/logger.js';
import { metrics } from '../monitoring/metrics.js';
import { enrichCorrelation } from '../monitoring/context.js';
import type { SessionService } from '../registry/session-service.js';

/**
 * Sessionful 2025-era serving.
 *
 * The installed SDK's 2026 (per-request) era issues no session id at all — there
 * is nothing to bind, because identity is re-established on every exchange and a
 * client cannot carry state across requests. The 2025 era *does* have a protocol
 * session id, and the supported seam for serving it is
 * `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator` +
 * `onsessioninitialized`/`onsessionclosed`. That is what this module wires.
 *
 * Scope, deliberately narrow: this handler is used for exactly two shapes of
 * 2025-era request —
 *
 *   * an `initialize` (which is where a session is created), and
 *   * any request that presents `mcp-session-id` (which must be validated).
 *
 * Everything else stays on the SDK's stateless leg. That is what keeps Phase 1–6
 * behaviour intact: a one-shot `tools/list` with no session id still works, and
 * it is still authenticated per exchange. When the client *does* keep the
 * session id the SDK gives it, the binding is enforced from then on.
 *
 * Two layers, deliberately separate:
 *
 *   * the **database** is the authority on ownership and liveness. A request is
 *     validated against it before the transport sees it, so a revoked credential,
 *     a disabled agent, a terminated session or another agent's session id never
 *     reaches a `tools/call` handler.
 *   * the **registry** is an in-process map from protocol session id to a live
 *     transport. It is a routing table, not a security boundary: a session that
 *     is absent here is refused, and one that is present is still re-validated
 *     against the database on every request.
 *
 * The registry is process-local, so a session created by one gateway process
 * cannot be served by another. That limitation is documented in
 * docs/ARCHITECTURE.md; the database still refuses to let a session change owner
 * across processes.
 */

export interface SessionIdentity {
  agent: Agent;
  credential: AgentCredential;
}

interface SessionEntry {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  internalId: string;
}

export interface McpSessionManagerOptions {
  service: SessionService;
  /** Builds the identity-scoped MCP surface. The same factory the modern path uses. */
  createServer: (identity: SessionIdentity) => Server;
  logger: Logger;
  maxRequestBodySize: number;
}

/** One uniform refusal for every session-level failure, so ownership is not disclosed. */
export function sessionNotFound(): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
    { status: 404 },
  );
}

/** A legacy request that asks the server to open a session: the only shape that creates one. */
export function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((message) => isInitializeBody(message));
  if (typeof body !== 'object' || body === null) return false;
  return (body as { method?: unknown }).method === 'initialize';
}

export class McpSessionManager {
  private readonly service: SessionService;
  private readonly createServer: (identity: SessionIdentity) => Server;
  private readonly logger: Logger;
  private readonly maxRequestBodySize: number;
  /** Bounded by construction: one entry per live session, removed on close. */
  private readonly entries = new Map<string, SessionEntry>();

  constructor(options: McpSessionManagerOptions) {
    this.service = options.service;
    this.createServer = options.createServer;
    this.logger = options.logger;
    this.maxRequestBodySize = options.maxRequestBodySize;
  }

  /**
   * Serves one 2025-era exchange that either initializes a session or presents
   * one. The caller has already authenticated the bearer token.
   */
  async handle(
    request: Request,
    identity: SessionIdentity,
    options: { authInfo?: AuthInfo; parsedBody?: unknown } = {},
  ): Promise<Response> {
    const { authInfo, parsedBody } = options;
    const requestOptions = {
      ...(authInfo === undefined ? {} : { authInfo }),
      ...(parsedBody === undefined ? {} : { parsedBody }),
    };

    const presented = request.headers.get('mcp-session-id');

    if (presented !== null) {
      // Ownership, liveness, credential state and agent state are all decided
      // here, before the transport is consulted. Both layers must agree.
      if ('failure' in this.service.validate(presented, identity)) {
        // One uniform 404 outside; two precise counters inside, because the
        // operator reading the metrics is trusted with the split.
        metrics.increment('umg_mcp_session_denied_total');
        metrics.increment('umg_authz_denials_total', { surface: 'session' });
        return sessionNotFound();
      }

      // A routing handle, not a credential: enriched so log lines inside this
      // exchange can name the session without another parameter.
      enrichCorrelation({ sessionId: presented });

      return this.entryFor(presented)?.transport.handleRequest(request, requestOptions) ?? sessionNotFound();
    }

    const created = await this.createEntry(identity);
    const response = await created.transport.handleRequest(request, requestOptions);

    // No session id after the exchange means this was not an initialize after
    // all (a legacy notification, a batched response, a refused request). The
    // server holds listeners, so it is released rather than leaked.
    if (created.transport.sessionId === undefined) {
      await created.server.close().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Transient MCP server could not be closed');
      });
    }

    return response;
  }

  /**
   * Releases one session's transport. Called after the database has recorded the
   * end, so a failure here leaves an honest (unusable) row rather than a live
   * transport the gateway believes is dead.
   */
  async close(mcpSessionId: string): Promise<boolean> {
    const entry = this.entries.get(mcpSessionId);
    if (entry === undefined) return false;
    this.entries.delete(mcpSessionId);

    await entry.server.close().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'MCP session transport could not be closed');
    });

    return true;
  }

  /** Closes every live transport. Used by graceful shutdown. */
  async closeAll(): Promise<number> {
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
    return ids.length;
  }

  get size(): number {
    return this.entries.size;
  }

  private entryFor(mcpSessionId: string): SessionEntry | undefined {
    return this.entries.get(mcpSessionId);
  }

  private async createEntry(identity: SessionIdentity): Promise<{
    server: Server;
    transport: WebStandardStreamableHTTPServerTransport;
  }> {
    const server = this.createServer(identity);
    const holder: { transport?: WebStandardStreamableHTTPServerTransport } = {};

    const transport = new WebStandardStreamableHTTPServerTransport({
      // 256 bits of entropy. The id is a routing handle, never a secret, but
      // guessing one must not be the cheapest way to probe a busy gateway.
      sessionIdGenerator: () => randomBytes(32).toString('base64url'),
      maxRequestBodySize: this.maxRequestBodySize,

      /**
       * Binding happens here, before the initialize response is returned, so a
       * client never holds an id the gateway has not persisted. A throw propagates
       * out of `handleRequest` and fails the initialization — correct, because an
       * unbound protocol session could only be refused on its next request.
       */
      onsessioninitialized: (mcpSessionId) => {
        const { session } = this.service.create(identity, mcpSessionId);
        this.entries.set(mcpSessionId, {
          server,
          transport: holder.transport!,
          internalId: session.id,
        });
        // Session creation is the one initialize outcome the gateway owns:
        // the SDK answers the request itself, and this callback fires exactly
        // when the exchange succeeded and a session exists. A refused or
        // malformed initialize never gets here — it is a method failure the
        // SDK reports, not a fact this process can observe.
        metrics.increment('umg_mcp_method_total', { method: 'initialize', outcome: 'success' });
        // Still inside the initialize request's async context, so the
        // session's own log lines can name it.
        enrichCorrelation({ sessionId: mcpSessionId });
      },

      /** A client `DELETE` is an explicit termination, not a mere disconnect. */
      onsessionclosed: (mcpSessionId) => {
        const entry = this.entries.get(mcpSessionId);
        if (entry === undefined) return;
        this.entries.delete(mcpSessionId);
        this.service.invalidate(entry.internalId, 'client_deleted', 'terminated');
      },
    });

    holder.transport = transport;
    // Awaited before serving: the transport receives the server's supported
    // protocol versions on connect, and `initialize` must not be handled before
    // that binding exists.
    await server.connect(transport);

    return { server, transport };
  }
}
