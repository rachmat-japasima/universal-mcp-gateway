import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ToolDefinition } from '../../domain/tool.js';
import type { Connector, ConnectorContext, ConnectorResult } from '../connector.js';
import { createSlackClient, type FetchLike, type SleepLike, type SlackClient } from './client.js';
import {
  isChannelId,
  isRecord,
  isTs,
  isUserId,
  normalizeConversation,
  normalizeMessage,
  normalizeUserInfo,
  slackListEnvelope,
  slackToolDefinitions,
  type Conversation,
  type Message,
  type UserInfo,
} from './tools.js';

/**
 * The Slack connector (ADR-056): the implementation behind the `slack`
 * registry entry.
 *
 * Read-only by construction — five GETs, one POST that only *asks the
 * gateway's own identity* (`auth.test`), and no write path exists in this
 * module to accidentally reach. The connector is stateless like the GitHub
 * and Notion ones: the token is resolved per operation through the scoped
 * resolver, a client is built per operation, nothing is cached.
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

/** Cursor-paginated query parameters, dropped when absent. */
function cursorParams(args: unknown): Record<string, string | number | undefined> {
  return { limit: argInt(args, 'limit'), cursor: argString(args, 'cursor') };
}

export interface SlackConnectorOptions {
  /** Injectable so tests run against fixture responses, never the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/**
 * Builds the connector. The registered instance uses the platform fetch; a
 * test passes fixture implementations of both seams (fetch and sleep) and
 * exercises the same code path production runs.
 */
export function createSlackConnector(options: SlackConnectorOptions = {}): Connector {
  /**
   * One client per operation, around the resolved token, with the same
   * failure-kind policy as GitHub and Notion: no credential stored is a
   * configuration problem, an unresolvable or foreign-connection reference
   * means the operator must store a new token.
   *
   * Slack's one addition: the provider is registered for **bot tokens**
   * (`xoxb-`), and Slack has other token families an operator could paste by
   * mistake. The prefix is checked here — before any network call — so a
   * user or app token gets an honest configuration answer instead of a
   * workspace that connects and then fails per request on missing scopes.
   */
  async function clientFor(context: ConnectorContext): Promise<ConnectorResult<SlackClient>> {
    if (context.credentialId === null) {
      return {
        ok: false,
        error: { kind: 'invalid_request', message: 'No credential is stored for this Slack connection.' },
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

    if (!token.startsWith('xoxb-')) {
      return {
        ok: false,
        error: {
          kind: 'invalid_request',
          message: 'The stored token is not a Slack bot token (expected xoxb-…).',
        },
      };
    }

    return {
      ok: true,
      value: createSlackClient({
        token,
        signal: context.signal,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }),
    };
  }

  /**
   * Discovery is the verification handshake: one `auth.test` — the one Slack
   * method that needs no scope — proving the token, the workspace, and the
   * bot's identity, then the five fixed tool definitions. The identity it
   * returns (team, bot user) is deliberately not stored: connections are
   * independent rows, never team-scoped, exactly like Notion's workspace
   * name. Scope breadth cannot be verified at connect time — Slack offers no
   * endpoint that lists a token's scopes — so it is enforced per request: a
   * token missing a scope fails closed with `missing_scope`, never silently.
   */
  async function discoverTools(context: ConnectorContext): Promise<ConnectorResult<ToolDefinition[]>> {
    const client = await clientFor(context);
    if (!client.ok) return client;

    const verified = await client.value.post('auth.test');
    if (!verified.ok) return verified;

    return { ok: true, value: slackToolDefinitions() };
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
      case 'list_conversations': {
        const types = isRecord(args) ? args.types : undefined;
        let typesParam: string | undefined;
        if (types !== undefined) {
          if (
            !Array.isArray(types) ||
            types.length === 0 ||
            !types.every((entry) => entry === 'public_channel' || entry === 'private_channel' || entry === 'mpim' || entry === 'im')
          ) {
            return malformed(toolName);
          }
          typesParam = types.join(',');
        }
        return listResult(
          await api.get('conversations.list', { types: typesParam, ...cursorParams(args) }),
          'channels',
          normalizeConversation,
        );
      }

      case 'get_conversation_info': {
        const channel = argString(args, 'channel');
        if (!isChannelId(channel)) return malformed(toolName);
        return detailResult(await api.get('conversations.info', { channel }), 'channel', normalizeConversation);
      }

      case 'get_conversation_history': {
        const channel = argString(args, 'channel');
        if (!isChannelId(channel)) return malformed(toolName);
        return listResult(
          await api.get('conversations.history', { channel, ...cursorParams(args) }),
          'messages',
          normalizeMessage,
        );
      }

      case 'get_thread_replies': {
        const channel = argString(args, 'channel');
        if (!isChannelId(channel)) return malformed(toolName);
        const ts = argString(args, 'ts');
        if (!isTs(ts)) return malformed(toolName);
        return listResult(
          await api.get('conversations.replies', { channel, ts, ...cursorParams(args) }),
          'messages',
          normalizeMessage,
        );
      }

      case 'get_user_info': {
        const user = argString(args, 'user');
        if (!isUserId(user)) return malformed(toolName);
        return detailResult(await api.get('users.info', { user }), 'user', normalizeUserInfo);
      }

      default:
        // The catalog only offers registered names; this is the defense in
        // depth for a caller that reaches the connector another way.
        return {
          ok: false,
          error: { kind: 'invalid_request', message: `Unknown Slack tool "${toolName}".` },
        };
    }
  }

  return { discoverTools, executeTool };
}

/**
 * A paginated read → `{ items, hasMore, nextCursor }`, unparseable entries
 * dropped. One page per call by design: the caller drives continuation with
 * `nextCursor` as `cursor`, so the gateway never loops, never accumulates,
 * and never auto-fetches anything.
 */
function listResult<T extends Record<string, unknown>>(
  response: ConnectorResult<unknown>,
  itemsKey: 'channels' | 'messages',
  normalize: (entry: unknown) => T | undefined,
): ConnectorResult<CallToolResult> {
  if (!response.ok) return response;
  const envelope = slackListEnvelope(response.value, itemsKey);
  if (envelope === undefined) {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Slack returned a response whose shape was not recognized.' },
    };
  }
  const items = envelope.items.map(normalize).filter((item): item is T => item !== undefined);
  return {
    ok: true,
    value: toolResult({ items, hasMore: envelope.hasMore, nextCursor: envelope.nextCursor }),
  };
}

/**
 * A single-object read → the named wrapper field (`channel`, `user`),
 * normalized, or an honest shape failure. Slack wraps detail objects beside
 * the `ok` verdict; the normalizer never sees the envelope.
 */
function detailResult<T extends Record<string, unknown>>(
  response: ConnectorResult<unknown>,
  bodyKey: 'channel' | 'user',
  normalize: (entry: unknown) => T | undefined,
): ConnectorResult<CallToolResult> {
  if (!response.ok) return response;
  const normalized = normalize(isRecord(response.value) ? response.value[bodyKey] : undefined);
  if (normalized === undefined) {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Slack returned a response whose shape was not recognized.' },
    };
  }
  return { ok: true, value: toolResult(normalized) };
}

/**
 * Text for every client plus the structured form for 2025-06-18 MCP clients.
 * The payload is the closed, normalized shape — never raw Slack JSON.
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
export const slackConnector: Connector = createSlackConnector();
