import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ToolDefinition } from '../../domain/tool.js';
import type { Connector, ConnectorContext, ConnectorResult } from '../connector.js';
import { createNotionClient, type FetchLike, type NotionClient, type SleepLike } from './client.js';
import {
  isNotionId,
  isRecord,
  notionListEnvelope,
  notionToolDefinitions,
  normalizeBlockSummary,
  normalizeDatabaseDetail,
  normalizeDataRow,
  normalizePageDetail,
  normalizeSearchEntry,
  type BlockSummary,
  type DatabaseDetail,
  type DataRow,
  type PageDetail,
  type SearchResult,
} from './tools.js';

/**
 * The Notion connector (ADR-055): the implementation behind the `notion`
 * registry entry.
 *
 * Read-only by construction — three GETs, two POSTs that only *query*, and
 * no write path exists in this module to accidentally reach. The connector is
 * stateless like the GitHub one: the token is resolved per operation through
 * the scoped resolver, a client is built per operation, nothing is cached.
 *
 * The gateway, not the connector, owns timeout and cancellation
 * (`withCancellation` wraps both methods from the service and the router).
 */

/** Arguments are opaque to the gateway; the connector reads them defensively. */
function argString(args: unknown, key: string): string | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function argInt(args: unknown, key: string): number | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function argBool(args: unknown, key: string): boolean | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

/** Cursor-paginated query parameters, dropped when absent. */
function cursorParams(args: unknown): Record<string, string | number | undefined> {
  return { page_size: argInt(args, 'page_size'), start_cursor: argString(args, 'start_cursor') };
}

export interface NotionConnectorOptions {
  /** Injectable so tests run against fixture responses, never the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/**
 * Builds the connector. The registered instance uses the platform fetch; a
 * test passes fixture implementations of both seams (fetch and sleep) and
 * exercises the same code path production runs.
 */
export function createNotionConnector(options: NotionConnectorOptions = {}): Connector {
  /**
   * One client per operation, around the resolved token, with the same
   * failure-kind policy as GitHub: no credential stored is a configuration
   * problem, an unresolvable or foreign-connection reference means the
   * operator must store a new token.
   */
  async function clientFor(context: ConnectorContext): Promise<ConnectorResult<NotionClient>> {
    if (context.credentialId === null) {
      return {
        ok: false,
        error: { kind: 'invalid_request', message: 'No credential is stored for this Notion connection.' },
      };
    }

    let token: string;
    try {
      token = await context.resolveCredential(context.credentialId);
    } catch {
      return {
        ok: false,
        error: {
          kind: 'reauthorization_required',
          message: 'The stored credential could not be resolved for this connection.',
        },
      };
    }

    return {
      ok: true,
      value: createNotionClient({
        token,
        signal: context.signal,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }),
    };
  }

  /**
   * Discovery is the verification handshake: one authenticated GET that
   * proves the token, then the six fixed tool definitions. Notion offers no
   * endpoint that lists a token's capabilities (they are configured in the
   * Notion developer portal), so this proves the credential is real; the
   * capability surface is then enforced by Notion per request — a connection
   * missing read-content fails closed with 403, never silently.
   */
  async function discoverTools(context: ConnectorContext): Promise<ConnectorResult<ToolDefinition[]>> {
    const client = await clientFor(context);
    if (!client.ok) return client;

    const verified = await client.value.get('/v1/users/me');
    if (!verified.ok) return verified;

    return { ok: true, value: notionToolDefinitions() };
  }

  async function executeTool(
    context: ConnectorContext,
    toolName: string,
    args: unknown,
  ): Promise<ConnectorResult<CallToolResult>> {
    // The router validates arguments against the advertised schema before the
    // connector runs; this guard is the defense in depth for any caller that
    // reaches the connector another way. `undefined` reads as "no arguments".
    if (args !== undefined && !isRecord(args)) return malformed(toolName);

    const client = await clientFor(context);
    if (!client.ok) return client;
    const api = client.value;

    switch (toolName) {
      case 'search': {
        // Omitted keys keep Notion's own defaults — a body that promised
        // different ones would be lying, so nothing is defaulted here.
        const body: Record<string, unknown> = {};
        const query = argString(args, 'query');
        if (query !== undefined) body.query = query;
        const objectFilter = argString(args, 'object_filter');
        if (objectFilter !== undefined) body.filter = { property: 'object', value: objectFilter };
        const inTrash = argBool(args, 'in_trash');
        if (inTrash !== undefined) body.in_trash = inTrash;
        const sortDirection = argString(args, 'sort_direction');
        if (sortDirection !== undefined) body.sort = { direction: sortDirection, timestamp: 'last_edited_time' };
        const pageSize = argInt(args, 'page_size');
        if (pageSize !== undefined) body.page_size = pageSize;
        const cursor = argString(args, 'start_cursor');
        if (cursor !== undefined) body.start_cursor = cursor;
        return listResult(await api.post('/v1/search', body), normalizeSearchEntry);
      }

      case 'get_page': {
        const pageId = argString(args, 'page_id');
        if (!isNotionId(pageId)) return malformed(toolName);
        return detailResult(await api.get(`/v1/pages/${pageId}`), normalizePageDetail);
      }

      case 'get_block': {
        const blockId = argString(args, 'block_id');
        if (!isNotionId(blockId)) return malformed(toolName);
        return detailResult(await api.get(`/v1/blocks/${blockId}`), normalizeBlockSummary);
      }

      case 'list_block_children': {
        const blockId = argString(args, 'block_id');
        if (!isNotionId(blockId)) return malformed(toolName);
        return listResult(
          await api.get(`/v1/blocks/${blockId}/children`, cursorParams(args)),
          normalizeBlockSummary,
        );
      }

      case 'get_database': {
        const databaseId = argString(args, 'database_id');
        if (!isNotionId(databaseId)) return malformed(toolName);
        return detailResult(await api.get(`/v1/databases/${databaseId}`), normalizeDatabaseDetail);
      }

      case 'query_data_source': {
        const dataSourceId = argString(args, 'data_source_id');
        if (!isNotionId(dataSourceId)) return malformed(toolName);

        // The filter/sorts objects are Notion's own grammar; the gateway
        // bounds their size in the advertised schema and passes them
        // through verbatim. Notion validates their internals.
        const body: Record<string, unknown> = {};
        const filter = isRecord(args) ? args.filter : undefined;
        if (filter !== undefined) {
          if (!isRecord(filter)) return malformed(toolName);
          body.filter = filter;
        }
        const sorts = isRecord(args) ? args.sorts : undefined;
        if (sorts !== undefined) {
          if (!Array.isArray(sorts)) return malformed(toolName);
          body.sorts = sorts;
        }
        const pageSize = argInt(args, 'page_size');
        if (pageSize !== undefined) body.page_size = pageSize;
        const cursor = argString(args, 'start_cursor');
        if (cursor !== undefined) body.start_cursor = cursor;
        return listResult(await api.post(`/v1/data_sources/${dataSourceId}/query`, body), normalizeDataRow);
      }

      default:
        // The catalog only offers registered names; this is the defense in
        // depth for a caller that reaches the connector another way.
        return {
          ok: false,
          error: { kind: 'invalid_request', message: `Unknown Notion tool "${toolName}".` },
        };
    }
  }

  return { discoverTools, executeTool };
}

/**
 * A paginated read → `{ items, hasMore, nextCursor }`, unparseable entries
 * dropped. One page per call by design: the caller drives continuation with
 * `nextCursor` as `start_cursor`, so the gateway never loops, never
 * accumulates, and never auto-fetches anything.
 */
function listResult<T extends Record<string, unknown>>(
  response: ConnectorResult<unknown>,
  normalize: (entry: unknown) => T | undefined,
): ConnectorResult<CallToolResult> {
  if (!response.ok) return response;
  const envelope = notionListEnvelope(response.value);
  if (envelope === undefined) {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Notion returned a response whose shape was not recognized.' },
    };
  }
  const items = envelope.results.map(normalize).filter((item): item is T => item !== undefined);
  return {
    ok: true,
    value: toolResult({ items, hasMore: envelope.hasMore, nextCursor: envelope.nextCursor }),
  };
}

/** A single-object read → the normalized detail, or an honest shape failure. */
function detailResult<T extends Record<string, unknown>>(
  response: ConnectorResult<unknown>,
  normalize: (entry: unknown) => T | undefined,
): ConnectorResult<CallToolResult> {
  if (!response.ok) return response;
  const normalized = normalize(response.value);
  if (normalized === undefined) {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Notion returned a response whose shape was not recognized.' },
    };
  }
  return { ok: true, value: toolResult(normalized) };
}

/**
 * Text for every client plus the structured form for 2025-06-18 MCP clients.
 * The payload is the closed, normalized shape — never raw Notion JSON.
 */
function toolResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function malformed(toolName: string): ConnectorResult<CallToolResult> {
  return {
    ok: false,
    error: { kind: 'invalid_request', message: `The arguments for "${toolName}" were malformed.` },
  };
}

/** The instance the registry registers: the platform fetch, no overrides. */
export const notionConnector: Connector = createNotionConnector();
