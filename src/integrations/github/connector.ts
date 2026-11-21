import type { CallToolResult } from '@modelcontextprotocol/client';

import type { ToolDefinition } from '../../domain/tool.js';
import type { Connector, ConnectorContext, ConnectorResult } from '../connector.js';
import { createGitHubClient, type FetchLike, type GitHubClient, type SleepLike } from './client.js';
import {
  githubToolDefinitions,
  isPullRequestEntry,
  isRecord,
  normalizeIssue,
  normalizeIssueDetail,
  normalizePullRequest,
  normalizePullRequestDetail,
  normalizeRepository,
  PAGINATION_DEFAULTS,
} from './tools.js';

/**
 * The GitHub connector (ADR-053): the implementation behind the `github`
 * registry entry.
 *
 * Read-only by construction — every route below is a GET, and no write path
 * exists in this module to accidentally reach. The connector is stateless:
 * the token is resolved per operation through the scoped resolver, a client
 * is built per operation around it, and nothing is cached between calls.
 *
 * The gateway, not the connector, owns timeout and cancellation
 * (`withCancellation` wraps both methods from the service and the router);
 * this module never races a clock of its own.
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

export interface GitHubConnectorOptions {
  /** Injectable so tests run against fixture responses, never the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/**
 * Builds the connector. The registered instance uses the platform fetch; a
 * test passes fixture implementations of both seams (fetch and sleep) and
 * exercises the same code path production runs.
 */
export function createGitHubConnector(options: GitHubConnectorOptions = {}): Connector {
  /**
   * One client per operation, around the resolved token. Failure kinds are
   * chosen for what the operator must do next: no credential stored is a
   * configuration problem (`invalid_request`), an unresolvable or
   * foreign-connection reference means the operator must re-store one
   * (`reauthorization_required`).
   */
  async function clientFor(context: ConnectorContext): Promise<ConnectorResult<GitHubClient>> {
    if (context.credentialId === null) {
      return {
        ok: false,
        error: { kind: 'invalid_request', message: 'No credential is stored for this GitHub connection.' },
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
      value: createGitHubClient({
        token,
        signal: context.signal,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }),
    };
  }

  /**
   * Discovery is the verification handshake: one authenticated GET that proves
   * the token, then the six fixed tool definitions. The response body is not
   * used beyond the 200 — proving the credential is the point, which is why
   * `connect()` refuses to reach `connected` without this succeeding.
   */
  async function discoverTools(context: ConnectorContext): Promise<ConnectorResult<ToolDefinition[]>> {
    const client = await clientFor(context);
    if (!client.ok) return client;

    const verified = await client.value.get('/user');
    if (!verified.ok) return verified;

    return { ok: true, value: githubToolDefinitions() };
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
      case 'list_repositories': {
        const response = await api.get('/user/repos', {
          page: argInt(args, 'page') ?? PAGINATION_DEFAULTS.page,
          per_page: argInt(args, 'per_page') ?? PAGINATION_DEFAULTS.per_page,
          visibility: argString(args, 'visibility'),
          sort: argString(args, 'sort'),
          direction: argString(args, 'direction'),
        });
        return listResult(response, normalizeRepository);
      }

      case 'get_repository': {
        const owner = argString(args, 'owner');
        const repo = argString(args, 'repo');
        if (owner === undefined || repo === undefined) return malformed(toolName);
        return detailResult(
          await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`),
          normalizeRepository,
        );
      }

      case 'list_issues': {
        const owner = argString(args, 'owner');
        const repo = argString(args, 'repo');
        if (owner === undefined || repo === undefined) return malformed(toolName);
        const response = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
          state: argString(args, 'state'),
          labels: argString(args, 'labels'),
          page: argInt(args, 'page') ?? PAGINATION_DEFAULTS.page,
          per_page: argInt(args, 'per_page') ?? PAGINATION_DEFAULTS.per_page,
        });
        // GitHub's issues endpoint mixes pull requests in; a pull request is
        // not an issue, so it is dropped before normalization.
        return listResult(response, (entry) => (isPullRequestEntry(entry) ? undefined : normalizeIssue(entry)));
      }

      case 'get_issue': {
        const owner = argString(args, 'owner');
        const repo = argString(args, 'repo');
        const number = argInt(args, 'issue_number');
        if (owner === undefined || repo === undefined || number === undefined) return malformed(toolName);
        return detailResult(
          await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`),
          normalizeIssueDetail,
        );
      }

      case 'list_pull_requests': {
        const owner = argString(args, 'owner');
        const repo = argString(args, 'repo');
        if (owner === undefined || repo === undefined) return malformed(toolName);
        const response = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
          state: argString(args, 'state'),
          page: argInt(args, 'page') ?? PAGINATION_DEFAULTS.page,
          per_page: argInt(args, 'per_page') ?? PAGINATION_DEFAULTS.per_page,
        });
        return listResult(response, normalizePullRequest);
      }

      case 'get_pull_request': {
        const owner = argString(args, 'owner');
        const repo = argString(args, 'repo');
        const number = argInt(args, 'pull_number');
        if (owner === undefined || repo === undefined || number === undefined) return malformed(toolName);
        return detailResult(
          await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`),
          normalizePullRequestDetail,
        );
      }

      default:
        // The catalog only offers registered names; this is the defense in
        // depth for a caller that reaches the connector another way.
        return {
          ok: false,
          error: { kind: 'invalid_request', message: `Unknown GitHub tool "${toolName}".` },
        };
    }
  }

  return { discoverTools, executeTool };
}

/** A paginated read → `{ items: [...] }`, unparseable entries dropped. */
function listResult<T>(
  response: ConnectorResult<unknown>,
  normalize: (entry: unknown) => T | undefined,
): ConnectorResult<CallToolResult> {
  if (!response.ok) return response;
  const items = Array.isArray(response.value)
    ? response.value.map(normalize).filter((item): item is T => item !== undefined)
    : [];
  return { ok: true, value: toolResult({ items }) };
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
      error: { kind: 'provider_error', message: 'GitHub returned a response whose shape was not recognized.' },
    };
  }
  return { ok: true, value: toolResult(normalized) };
}

/**
 * Text for every client plus the structured form for 2025-06-18 MCP clients.
 * The payload is the closed, normalized shape — never raw GitHub JSON.
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
export const githubConnector: Connector = createGitHubConnector();
