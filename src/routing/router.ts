import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ActivityType } from '../domain/activity-event.js';
import type { Backend } from '../domain/backend.js';
import type { CatalogTool } from '../domain/tool.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AppError, describeErrorForLog } from '../shared/errors.js';
import type { BackendLifecycleManager } from '../adapters/lifecycle.js';
import { normalizeMcpError } from '../adapters/mcp-client.js';
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
  private readonly now: () => string;
  private readonly timeoutMs: number;

  constructor(options: RouterOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.lifecycle = options.lifecycle;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Public entry point used by `tools/call`. Throws `AppError` for every pre-call rejection. */
  async call(publicName: string, args: unknown, context: RoutingContext = {}): Promise<RoutedCall> {
    const startedAt = Date.now();
    const tool = this.resolve(publicName);

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
      { backendId: tool.backendId, tool: publicName, requestId: context.requestId },
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
        outcome: result.isError === true ? 'tool-error' : 'success',
        durationMs,
      },
      'Tool invocation completed',
    );

    return { tool, result: normalizeResult(result), durationMs };
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
   * The catalog says a backend tool exists; the runtime says whether it can be
   * reached. A disabled or absent backend is a stale mapping, not a call to
   * forward and hope.
   */
  private assertReachable(tool: CatalogTool, context: RoutingContext): Backend {
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
        { backendId: tool.backendId, tool: tool.publicName, reason: compiled.unvalidatedReason },
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

  private rejectStale(tool: CatalogTool, context: RoutingContext, reason: string): void {
    this.logger.warn(
      { backendId: tool.backendId, tool: tool.publicName, requestId: context.requestId, reason },
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
  private fail(tool: CatalogTool, error: unknown, context: RoutingContext, startedAt: number): AppError {
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
    try {
      this.store.activity.append({
        id: randomUUID(),
        type,
        outcome,
        backendId: fields.tool.backendId,
        toolName: fields.tool.publicName,
        createdAt: this.now(),
        ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
        ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode }),
        ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
      });
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Activity event could not be recorded');
    }
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
