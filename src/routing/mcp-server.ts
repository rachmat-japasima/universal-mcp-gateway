import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
} from '@modelcontextprotocol/server';

import type { Agent } from '../domain/agent.js';
import type { CatalogTool } from '../domain/tool.js';
import type { Logger } from '../monitoring/logger.js';
import type { AuthorizationService } from '../auth/authorization.js';
import { toolTarget } from '../auth/authorization.js';
import { AppError } from '../shared/errors.js';
import { SERVICE_INFO } from '../shared/service.js';
import type { ToolCatalog } from './catalog.js';
import type { ToolRouter } from './router.js';

/**
 * The gateway's own MCP surface.
 *
 * Built on the low-level `Server` rather than `McpServer` on purpose: the
 * catalog is runtime data, not a static registration, and `McpServer.registerTool`
 * binds one handler per tool at construction time. The low-level server takes
 * `tools/list` and `tools/call` handlers that read the live catalog, and the
 * SDK still wraps the result in its era codec (`Protocol._wrapHandler`), so both
 * protocol eras get their wire-shape validation.
 *
 * One instance per exchange (ADR-020). It holds no state of its own: publishing
 * the catalog is a read, and routing is a lookup on shared services. That is why
 * a catalog change is visible on the very next request without any notification
 * plumbing — and why `listChanged` is not advertised.
 *
 * Phase 6 adds one thing to that picture: the factory is given the identity the
 * HTTP middleware authenticated, and every read and call is filtered through the
 * authorization service for *that* identity. The server instance cannot be reused
 * across agents, because its identity is fixed at construction.
 */

export interface McpSurfaceOptions {
  catalog: ToolCatalog;
  router: ToolRouter;
  authorization: AuthorizationService;
  logger: Logger;
}

/**
 * Identity is per exchange; the factory is called once per request by the SDK.
 *
 * The credential id travels with the identity rather than being dug out of the
 * SDK's `authInfo` later: it is known here, it is the only thing the audit
 * trail needs, and keeping it out of the wire-side object avoids a cast on a
 * field that may be absent.
 */
export interface McpSurfaceIdentity {
  agent: Agent;
  credentialId: string;
}

export function createGatewayServerFactory(
  options: McpSurfaceOptions,
): (identity: McpSurfaceIdentity) => Server {
  const { catalog, router, authorization, logger } = options;

  return (identity) => {
    const server = new Server(SERVICE_INFO, { capabilities: { tools: {} } });
    const { agent, credentialId } = identity;

    server.setRequestHandler('tools/list', () => ({
      // No cursor: the catalog is a single bounded snapshot and the SDK
      // aggregates pages automatically for clients. Inventing pagination would
      // be a non-standard scheme for a list that already fits.
      //
      // Only tools this agent may call are published. Listing is a view, not the
      // boundary — `tools/call` re-checks — but publishing an unauthorized name
      // would leak topology and invite probing.
      //
      // The cast is the one place the gateway asserts a shape it has already
      // validated: `toDefinition` rejects any tool whose `inputSchema` is not an
      // object schema, which is the only part of `Tool` TypeScript cannot infer.
      tools: authorization.visibleTools(agent).map(toWireTool) as Tool[],
    }));

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const signal = ctx.mcpReq?.signal;
      // The JSON-RPC id is the only correlation handle a protocol client gives
      // us; it is not secret, and it is what a client will quote in a bug report.
      // Bounded because the wire allows an arbitrarily long string id.
      const requestId = String(ctx.mcpReq.id).slice(0, 64);
      const publicName = request.params.name;

      try {
        /**
         * `router.call` authorizes *before* it resolves, so a denied caller
         * cannot tell "no such tool" from "exists but not yours" by timing or by
         * a different error, and the audit row is written once, in one place.
         * `tools/list` filters through the same service, so the view and the
         * boundary cannot drift.
         */
        const { result } = await router.call(publicName, request.params.arguments ?? {}, {
          requestId,
          agent,
          credentialId,
          ...(signal === undefined ? {} : { signal }),
        });

        // The SDK's own projection applies the era rules (a non-object
        // `structuredContent` root is wrapped on the 2025 wire, identity on
        // 2026). Doing it here keeps both eras consistent with `McpServer`.
        return server.projectCallToolResult(result, advertisedOutputSchema(publicName));
      } catch (error) {
        throw toProtocolError(error, publicName, logger);
      }
    });

    return server;
  };

  /**
   * The advertised output schema is read from the catalog at call time. If the
   * tool vanished between `tools/list` and `tools/call`, `undefined` is correct:
   * the call will fail on routing anyway.
   */
  function advertisedOutputSchema(name: string): Record<string, unknown> | undefined {
    const resolved = catalog.resolve(name);
    return 'tool' in resolved ? resolved.tool.outputSchema : undefined;
  }
}

/**
 * Emits only what MCP defines. Internal fields (`availability`, `backendId`,
 * `originalName`) stay inside the gateway: exposing routing detail to a client
 * would leak the topology without helping it call anything.
 */
function toWireTool(tool: CatalogTool): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    name: tool.publicName,
    inputSchema: tool.inputSchema,
  };

  if (tool.title !== undefined) wire['title'] = tool.title;
  if (tool.description !== undefined) wire['description'] = tool.description;
  if (tool.outputSchema !== undefined) wire['outputSchema'] = tool.outputSchema;
  if (tool.annotations !== undefined) wire['annotations'] = tool.annotations;
  if (tool.execution !== undefined) wire['execution'] = tool.execution;
  if (tool._meta !== undefined) wire['_meta'] = tool._meta;
  if (tool.icons !== undefined) wire['icons'] = tool.icons;

  return wire;
}

/**
 * JSON-RPC `-32800`: the request was cancelled (MCP spec, `notifications/cancelled`).
 * The SDK's `ProtocolErrorCode` enum has no name for it, so the number is used.
 */
const REQUEST_CANCELLED = -32800;

/**
 * Maps a gateway failure onto the MCP error vocabulary.
 *
 * Three deliberate choices:
 *  - an unknown tool is `InvalidParams` (`-32602`), matching what the SDK's own
 *    `tools/call` handler answers, so a client cannot tell which implemen-
 *    tation is behind the endpoint — and an authorization denial is mapped onto
 *    the same code and message before it reaches here (see above), so the two
 *    cases are indistinguishable on the wire;
 *  - cancellation uses the spec's cancellation code, so a client that aborted
 *    does not need to interpret a generic internal error;
 *  - a tool-level failure that has already produced a `CallToolResult` is never
 *    converted into a protocol error; only routing failures reach here.
 *
 * The message is the `AppError` message, which is written for a caller and
 * carries no path, stack, or backend detail.
 */
function toProtocolError(error: unknown, publicName: string, logger: Logger): ProtocolError {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'TOOL_NOT_FOUND':
        // A fixed message, not the AppError's: a name that exists but is not
        // yours and a name that was never published must produce byte-identical
        // answers. The client already knows the name it asked for.
        return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
      case 'RESOURCE_CONFLICT':
      case 'VALIDATION_ERROR':
        return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
      case 'TOOL_CANCELLED':
        return new ProtocolError(REQUEST_CANCELLED, error.message);
      default:
        return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
    }
  }

  logger.error({ tool: publicName }, 'Unhandled tool routing error');
  return new ProtocolError(ProtocolErrorCode.InternalError, 'The gateway could not complete the tool call.');
}
