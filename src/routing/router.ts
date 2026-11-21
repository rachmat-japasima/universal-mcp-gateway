import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ActivityType } from '../domain/activity-event.js';
import type { Agent } from '../domain/agent.js';
import type { Backend } from '../domain/backend.js';
import type { CatalogTool, ManagedCatalogTool, McpCatalogTool } from '../domain/tool.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { metrics } from '../monitoring/metrics.js';
import { correlationContext, enrichCorrelation } from '../monitoring/context.js';
import { AppError, describeErrorForLog } from '../shared/errors.js';
import { withCancellation, type ConnectorContext, type ConnectorError } from '../integrations/connector.js';
import type { IntegrationRuntime } from '../integrations/runtime.js';
import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import { normalizeMcpError } from '../adapters/mcp-client.js';
import type { AuthorizationService } from '../auth/authorization.js';
import type { AccessDecision } from '../domain/policy.js';
import type { ToolCatalog } from './catalog.js';
import { compileInputSchema } from './schema.js';

/**
 * Tool call router.
 *
 * The only place that knows how a public name becomes a backend call. It is
 * transport-blind by construction: it never sees an adapter, a process, or a
 * URL — only `McpBackendClient` through the lifecycle accessor.
 *
 * Resolution is done *at call time* and re-checked against runtime truth before
 * forwarding. A mapping read from the catalog is a hint; `isConnected` is the
 * fact. That extra check is what prevents a call racing a disconnect from
 * reaching a closed client.
 */

export interface RouterOptions {
  store: Database;
  logger: Logger;
  lifecycle: BackendLifecycleManager;
  catalog: ToolCatalog;
  /**
   * When supplied, every call must carry an authenticated agent and is
   * re-authorized here before anything is resolved or dispatched. The MCP
   * surface already filters, but this is the boundary: a direct caller of
   * `call()` cannot reach a backend without a decision.
   */
  authorization?: AuthorizationService;
  /**
   * The managed-integration side of the source seam (ADR-049). When supplied,
   * managed tools dispatch through it; when absent, every managed tool fails
   * closed as unavailable — there is no fallback that could bypass the seam.
   */
  integrations?: IntegrationRuntime;
  now?: () => string;
  /**
   * Ceiling for one routed call. The backend's own `timeoutMs` applies inside
   * the client; this is the outer bound so a misconfigured backend cannot pin an
   * inbound request open.
   */
  timeoutMs?: number;
}

export interface RoutingContext {
  requestId?: string;
  /** Cancellation from the MCP request (`ctx.mcpReq.signal`). */
  signal?: AbortSignal;
  /** The authenticated caller. Required when the router has an authorization service. */
  agent?: Agent;
  credentialId?: string;
}

export interface RoutedCall {
  tool: CatalogTool;
  result: CallToolResult;
  durationMs: number;
}

export class ToolRouter {
  private readonly store: Database;
  private readonly logger: Logger;
  private readonly lifecycle: BackendLifecycleManager;
  private readonly catalog: ToolCatalog;
  private readonly authorization: AuthorizationService | undefined;
  private readonly integrations: IntegrationRuntime | undefined;
  private readonly now: () => string;
  private readonly timeoutMs: number;

  constructor(options: RouterOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.lifecycle = options.lifecycle;
    this.catalog = options.catalog;
    this.authorization = options.authorization;
    this.integrations = options.integrations;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Public entry point used by `tools/call`. Throws `AppError` for every pre-call rejection. */
  async call(publicName: string, args: unknown, context: RoutingContext = {}): Promise<RoutedCall> {
    const startedAt = Date.now();

    /**
     * Authorization precedes routing.
     *
     * Two reasons, and both matter: a denied caller must not be able to learn
     * from a different error whether the name they guessed exists, and no work
     * beyond the decision should happen for a name the caller may not use — no
     * backend read, no reachability check, no schema compile, no invocation.
     * Every rejection below this point is therefore already the caller's own
     * tool.
     *
     * The decision itself reads the catalog once (see `authorize`): a
     * `backend`-scoped rule cannot be evaluated without knowing the tool's
     * backend. That read is in-memory, happens identically for a real and an
     * invented name, and its result re-enriches the audit row.
     */
    if (this.authorization !== undefined) {
      const decision = this.authorize(publicName, context);
      if (!decision.allowed) {
        this.authorization.logDecision(decision, publicName, context.requestId);
        this.authorization.safeAudit(decision, {
          ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
          ...(context.credentialId === undefined ? {} : { credentialId: context.credentialId }),
        });

        // The aggregate twin of the denial the audit row above records.
        metrics.increment('umg_tool_calls_total', { outcome: 'denied' });
        metrics.increment('umg_authz_denials_total', { surface: 'tool' });

        // Same code and message as an unknown name. The reason stays internal.
        throw new AppError('TOOL_NOT_FOUND', `Unknown tool "${publicName}".`, {
          details: { publicName },
        });
      }
    }

    const tool = this.resolve(publicName);

    // Enriches the request's correlation context: the resolved tool and its
    // source are now known, so later log lines can name them. The two id
    // fields are mutually exclusive by source type (ADR-048).
    enrichCorrelation(
      tool.sourceType === 'mcp_backend'
        ? { backendId: tool.sourceId, toolId: tool.publicName }
        : { connectionId: tool.sourceId, toolId: tool.publicName },
    );

    // The source seam (ADR-049): a managed tool never reaches a line of the
    // MCP path below, and an MCP tool never reaches a connector. Everything
    // under this branch is the unchanged Phase 11 backend path.
    if (tool.sourceType === 'managed_integration') {
      return this.callManaged(tool, args, context, startedAt);
    }

    const backend = this.assertReachable(tool, context);
    const arguments_ = this.validateArguments(tool, args, context);

    const client = this.lifecycle.activeClient(tool.backendId);
    if (client === undefined) {
      // Lost the race with a disconnect between resolve and dispatch.
      this.record('tools.call', 'failure', {
        tool,
        requestId: context.requestId,
        errorCode: 'TOOL_UNAVAILABLE',
        durationMs: Date.now() - startedAt,
      });
      throw new AppError('TOOL_UNAVAILABLE', `The backend for "${publicName}" is no longer connected.`);
    }

    if (context.signal?.aborted === true) throw cancelled(publicName, context);

    this.logger.info(
      { backendId: tool.backendId, tool: publicName, requestId: context.requestId, ...this.correlationFields() },
      'Tool invocation started',
    );

    let result: CallToolResult;
    try {
      result = await client.callTool(tool.originalName, arguments_, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        // The backend's own budget always wins; this only caps it.
        timeoutMs: Math.min(this.timeoutMs, backend.timeoutMs),
      });
    } catch (error) {
      throw this.fail(tool, error, context, startedAt);
    }

    const durationMs = Date.now() - startedAt;

    // A backend may answer `isError: true` for a tool-level failure. That is a
    // successful round trip and a failed call, and both facts are recorded.
    this.record('tools.call', result.isError === true ? 'failure' : 'success', {
      tool,
      requestId: context.requestId,
      errorCode: result.isError === true ? 'TOOL_UNAVAILABLE' : undefined,
      durationMs,
    });

    this.logger.info(
      {
        backendId: tool.backendId,
        tool: publicName,
        requestId: context.requestId,
        ...this.correlationFields(),
        outcome: result.isError === true ? 'tool-error' : 'success',
        durationMs,
      },
      'Tool invocation completed',
    );

    return { tool, result: normalizeResult(result), durationMs };
  }

  /**
   * The managed-integration dispatch (ADR-049). Same discipline as the MCP
   * path, in the same order — reachability, argument validation, then the
   * call — because authorization already happened at the top of `call()` and
   * must not be repeated differently per source.
   */
  private async callManaged(
    tool: ManagedCatalogTool,
    args: unknown,
    context: RoutingContext,
    startedAt: number,
  ): Promise<RoutedCall> {
    // No runtime wired (or a store without integrations): fail closed. There
    // is deliberately no "try the backend path anyway" fallback.
    if (this.integrations === undefined) {
      this.record('tools.call', 'failure', {
        tool,
        requestId: context.requestId,
        errorCode: 'TOOL_UNAVAILABLE',
        durationMs: Date.now() - startedAt,
      });
      throw new AppError('TOOL_UNAVAILABLE', `The tool "${tool.publicName}" is not available.`);
    }

    const reachable = this.integrations.dispatchable(tool.sourceId);
    if ('unavailable' in reachable) {
      this.logger.warn(
        {
          connectionId: tool.sourceId,
          tool: tool.publicName,
          requestId: context.requestId,
          ...this.correlationFields(),
          reason: reachable.unavailable,
        },
        'Managed tool mapping rejected',
      );
      this.record('tools.call', 'failure', {
        tool,
        requestId: context.requestId,
        errorCode: 'TOOL_UNAVAILABLE',
        durationMs: Date.now() - startedAt,
      });
      throw new AppError('TOOL_UNAVAILABLE', `The tool "${tool.publicName}" is not available.`);
    }

    const arguments_ = this.validateArguments(tool, args, context);

    if (context.signal?.aborted === true) throw cancelled(tool.publicName, context);

    const { dispatch } = reachable;
    const connectorContext: ConnectorContext = {
      connectionId: tool.sourceId,
      credentialId: dispatch.connection.credentialId,
      metadata: dispatch.connection.metadata,
      resolveCredential: dispatch.resolveCredential,
      timeoutMs: dispatch.timeoutMs,
      // The call's cancellation is the request's; a caller without a signal
      // gets a never-aborting one rather than `undefined` semantics drifting
      // into the connector contract.
      signal: context.signal ?? new AbortController().signal,
    };

    this.logger.info(
      { connectionId: tool.sourceId, tool: tool.publicName, requestId: context.requestId, ...this.correlationFields() },
      'Managed tool invocation started',
    );

    const outcome = await withCancellation(connectorContext, () =>
      dispatch.executeTool(connectorContext, tool.originalName, arguments_),
    );

    const durationMs = Date.now() - startedAt;

    if (!outcome.ok) {
      if (outcome.error.kind === 'reauthorization_required') {
        try {
          this.integrations.markReauthorizationRequired(tool.sourceId);
        } catch (error) {
          // Best effort: the call has already failed; a failed bookkeeping
          // write must not mask the caller's error.
          this.logger.warn(
            { error: describeErrorForLog(error), connectionId: tool.sourceId },
            'Connection reauthorization transition could not be recorded',
          );
        }
      }

      const failure = connectorFailure(outcome.error, tool.publicName);
      this.record('tools.call', 'failure', {
        tool,
        requestId: context.requestId,
        errorCode: failure.code,
        durationMs,
      });
      this.logger.warn(
        {
          connectionId: tool.sourceId,
          tool: tool.publicName,
          requestId: context.requestId,
          ...this.correlationFields(),
          code: failure.code,
          durationMs,
        },
        'Managed tool invocation failed',
      );
      throw failure;
    }

    // A connector may answer `isError: true` for a tool-level failure, exactly
    // like a backend. Successful round trip, failed call — both recorded.
    this.record('tools.call', outcome.value.isError === true ? 'failure' : 'success', {
      tool,
      requestId: context.requestId,
      errorCode: outcome.value.isError === true ? 'TOOL_UNAVAILABLE' : undefined,
      durationMs,
    });

    this.logger.info(
      {
        connectionId: tool.sourceId,
        tool: tool.publicName,
        requestId: context.requestId,
        ...this.correlationFields(),
        outcome: outcome.value.isError === true ? 'tool-error' : 'success',
        durationMs,
      },
      'Managed tool invocation completed',
    );

    return { tool, result: outcome.value, durationMs };
  }

  /** Resolves without connecting or validating. Exposed for `tools/list` consumers and tests. */
  resolve(publicName: string): CatalogTool {
    const resolved = this.catalog.resolve(publicName);

    if ('tool' in resolved) return resolved.tool;

    if (resolved.reason === 'conflict') {
      throw new AppError('RESOURCE_CONFLICT', `The tool name "${publicName}" is ambiguous and cannot be called.`, {
        details: { publicName },
      });
    }
    if (resolved.reason === 'unavailable') {
      throw new AppError('TOOL_UNAVAILABLE', resolved.detail ?? `The tool "${publicName}" is not available.`, {
        details: { publicName },
      });
    }
    throw new AppError('TOOL_NOT_FOUND', `Unknown tool "${publicName}".`, { details: { publicName } });
  }

  /**
   * The authorization check. A router with an authorization service refuses to
   * act without an authenticated agent: there is no "anonymous but allowed"
   * mode, because that would be a bypass with extra steps.
   */
  private authorize(publicName: string, context: RoutingContext): AccessDecision {
    if (this.authorization === undefined) {
      throw new AppError('INTERNAL_ERROR', 'Authorization is not configured.');
    }

    if (context.agent === undefined) {
      throw new AppError('AUTHENTICATION_ERROR', 'The caller has no authenticated identity.');
    }

    return this.authorization.evaluate(context.agent, this.authorization.resolveTarget(publicName));
  }

  /**
   * The catalog says a backend tool exists; the runtime says whether it can be
   * reached. A disabled or absent backend is a stale mapping, not a call to
   * forward and hope.
   *
   * Takes the MCP variant by type: a managed tool cannot reach this check,
   * which is the seam (ADR-049) enforced by the compiler rather than by
   * discipline.
   */
  private assertReachable(tool: McpCatalogTool, context: RoutingContext): Backend {
    const backend = this.store.backends.findById(tool.backendId);

    if (backend === undefined) {
      this.rejectStale(tool, context, 'The backend no longer exists.');
      throw new AppError('TOOL_UNAVAILABLE', 'The backend for this tool no longer exists.', {
        details: { publicName: tool.publicName },
      });
    }

    if (!backend.enabled) {
      this.rejectStale(tool, context, 'The backend is disabled.');
      throw new AppError('TOOL_UNAVAILABLE', 'The backend for this tool is disabled.', {
        details: { publicName: tool.publicName },
      });
    }

    if (!this.lifecycle.isConnected(tool.backendId)) {
      this.rejectStale(tool, context, 'The backend is not connected.');
      throw new AppError('TOOL_UNAVAILABLE', 'The backend for this tool is not connected.', {
        details: { publicName: tool.publicName },
      });
    }

    return backend;
  }

  /**
   * Validates the caller's arguments against the backend's own JSON Schema.
   * Unknown keys are rejected, because MCP declares an object schema and a
   * backend that omits `additionalProperties` should not silently receive
   * fields it never advertised.
   */
  private validateArguments(tool: CatalogTool, args: unknown, context: RoutingContext): Record<string, unknown> {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new AppError('VALIDATION_ERROR', 'Tool arguments must be a JSON object.', {
        details: { publicName: tool.publicName },
      });
    }

    const record = (args ?? {}) as Record<string, unknown>;
    const compiled = compileInputSchema(tool.inputSchema);

    if (compiled.validate === undefined) {
      this.logger.warn(
        {
          ...(tool.sourceType === 'mcp_backend' ? { backendId: tool.backendId } : { connectionId: tool.sourceId }),
          tool: tool.publicName,
          reason: compiled.unvalidatedReason,
        },
        'Tool arguments forwarded without validation',
      );
      return record;
    }

    const verdict = compiled.validate(record);
    if (!verdict.valid) {
      this.record('tools.call', 'failure', {
        tool,
        requestId: context.requestId,
        errorCode: 'VALIDATION_ERROR',
        durationMs: undefined,
      });
      throw new AppError('VALIDATION_ERROR', verdict.message ?? 'The tool arguments are invalid.', {
        details: { publicName: tool.publicName },
      });
    }

    return record;
  }

  private rejectStale(tool: McpCatalogTool, context: RoutingContext, reason: string): void {
    this.logger.warn(
      {
        backendId: tool.backendId,
        tool: tool.publicName,
        requestId: context.requestId,
        ...this.correlationFields(),
        reason,
      },
      'Stale tool mapping rejected',
    );
    this.record('tools.call', 'failure', {
      tool,
      requestId: context.requestId,
      errorCode: 'TOOL_UNAVAILABLE',
      durationMs: undefined,
    });
  }

  /** Classifies a dispatch failure, records it, and returns it for the caller to throw. */
  private fail(tool: McpCatalogTool, error: unknown, context: RoutingContext, startedAt: number): AppError {
    // Cancellation is decided by the caller's signal, not by the error's shape:
    // the SDK's abort error carries no stable code, and a backend may report the
    // same cancellation differently or not at all.
    const cancelledByCaller = context.signal?.aborted === true;

    const normalized = cancelledByCaller
      ? new AppError('TOOL_CANCELLED', 'The tool call was cancelled.', { cause: error })
      : normalizeMcpError(error, `Calling tool "${tool.publicName}" failed`);

    this.record('tools.call', 'failure', {
      tool,
      requestId: context.requestId,
      errorCode: normalized.code,
      durationMs: Date.now() - startedAt,
    });

    this.logger.warn(
      {
        backendId: tool.backendId,
        tool: tool.publicName,
        requestId: context.requestId,
        ...this.correlationFields(),
        code: normalized.code,
        durationMs: Date.now() - startedAt,
      },
      normalized.code === 'TOOL_CANCELLED' ? 'Tool invocation cancelled' : 'Tool invocation failed',
    );

    return normalized;
  }

  private record(
    type: ActivityType,
    outcome: 'success' | 'failure',
    fields: { tool: CatalogTool; requestId?: string; errorCode?: string; durationMs?: number },
  ): void {
    // The aggregate twin of the row written below: the same call, counted
    // without the tool name. Names and identities stay in the activity trail,
    // where the request id can correlate them.
    metrics.increment('umg_tool_calls_total', { outcome });
    if (fields.errorCode !== undefined) metrics.increment('umg_tool_failures_total', { code: fields.errorCode });
    if (fields.durationMs !== undefined) metrics.observe('umg_tool_call_duration_ms', {}, fields.durationMs);

    try {
      // The HTTP-level correlation id of the exchange this call arrived on.
      // Absent when `record()` runs outside a request (nothing fabricates one).
      const correlationId = correlationContext()?.correlationId;

      this.store.activity.append({
        id: randomUUID(),
        type,
        outcome,
        // Exactly one of the two: the row names its source by type, never a
        // connection id under the backend label (ADR-048).
        ...(fields.tool.sourceType === 'mcp_backend'
          ? { backendId: fields.tool.backendId }
          : { connectionId: fields.tool.sourceId }),
        toolName: fields.tool.publicName,
        createdAt: this.now(),
        ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode }),
        ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
      });
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Activity event could not be recorded');
    }
  }

  /** Correlation fields for this exchange's log lines; empty outside a request. */
  private correlationFields(): { correlationId?: string } {
    const context = correlationContext();
    return context === undefined ? {} : { correlationId: context.correlationId };
  }
}

/**
 * A tool-level result carries `content` and optionally `structuredContent`.
 * Nothing is rewritten except the one thing the 2025 wire codec forbids: a
 * non-object `structuredContent` root, which is wrapped rather than dropped.
 */
function normalizeResult(result: CallToolResult): CallToolResult {
  const structured = result.structuredContent;

  if (structured !== undefined && (structured === null || typeof structured !== 'object' || Array.isArray(structured))) {
    return {
      ...result,
      structuredContent: { result: structured },
    };
  }

  return result;
}

function cancelled(publicName: string, context: RoutingContext): AppError {
  return new AppError('TOOL_CANCELLED', 'The tool call was cancelled before it was dispatched.', {
    details: { publicName },
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  });
}

/**
 * Maps a connector's normalized failure onto the gateway's error vocabulary.
 * The client sees a fixed message; the connector's own words go to `details`,
 * which never leaves the process — a provider message can name URLs, scopes or
 * internal paths. The existing `BACKEND_*` codes are reused deliberately
 * (ADR-049): they are transport-neutral from a client's perspective, and
 * renaming public error codes is a versioned API change held for Phase 14.
 */
function connectorFailure(error: ConnectorError, publicName: string): AppError {
  switch (error.kind) {
    case 'timeout':
      return new AppError('BACKEND_TIMEOUT', `Calling tool "${publicName}" timed out.`, {
        details: { publicName, connectorMessage: error.message },
      });
    case 'unreachable':
      return new AppError('BACKEND_UNAVAILABLE', `The provider for "${publicName}" is unreachable.`, {
        details: { publicName, connectorMessage: error.message },
      });
    case 'invalid_request':
      return new AppError('VALIDATION_ERROR', `The arguments for "${publicName}" were rejected.`, {
        details: { publicName, connectorMessage: error.message },
      });
    case 'reauthorization_required':
      return new AppError('TOOL_UNAVAILABLE', `The connection for "${publicName}" requires reauthorization.`, {
        details: { publicName, connectorMessage: error.message },
      });
    case 'provider_error':
      return new AppError('BACKEND_CONNECTION_ERROR', `Calling tool "${publicName}" failed.`, {
        details: { publicName, connectorMessage: error.message },
      });
  }
}
