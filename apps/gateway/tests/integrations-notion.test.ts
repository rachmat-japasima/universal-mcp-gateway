import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackendLifecycleManager, type ReconnectPolicy } from '../src/adapters/lifecycle.js';
import { AuthorizationService } from '../src/auth/authorization.js';
import type { Policy } from '../src/domain/policy.js';
import { loadConfig } from '../src/config/config.js';
import type { ConnectorContext, ConnectorError, ConnectorResult } from '../src/integrations/connector.js';
import type { Connector } from '../src/integrations/connector.js';
import { ProviderRegistry, githubRegistration, notionRegistration } from '../src/integrations/registry.js';
import { IntegrationService } from '../src/integrations/service.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';
import { createGitHubConnector } from '../src/integrations/github/connector.js';
import { createNotionClient, type FetchLike } from '../src/integrations/notion/client.js';
import { createNotionConnector } from '../src/integrations/notion/connector.js';
import { notionToolDefinitions } from '../src/integrations/notion/tools.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { PolicyService } from '../src/registry/policy-service.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { ToolCatalog } from '../src/routing/catalog.js';
import { ToolRouter } from '../src/routing/router.js';
import { compileInputSchema } from '../src/routing/schema.js';

/**
 * The Notion provider against fixture HTTP responses (ADR-055). No request
 * leaves the process: every fetch and every sleep is injected, and the
 * negative assertions pin the boundaries — the token never travels outside
 * the Authorization header, Notion's own fields never leave the normalizers,
 * and unknown/future block types are recorded rather than dropped.
 *
 * The last two describes drive the real `IntegrationService`, the real
 * `ToolCatalog`, and the real `ToolRouter` with the real registration — only
 * the HTTP seam is a fixture — including two Notion connections, two agents,
 * and a GitHub connection publishing alongside.
 */

const TOKEN = 'ntn_fixture-only-never-real-token';
const NOW = '2026-11-22T00:00:00.000Z';

// Legal Notion ids in both accepted shapes.
const PAGE_ID = '3f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b';
const BLOCK_ID = '4f5e7a9c-1b2d-4e6f-8a0b-2c4d6e8f0a2b';
const DATABASE_ID = '5f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b';
const DATA_SOURCE_ID = '6f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b';
const RELATION_ID = '7f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b';

/** A context whose resolver answers only this connection's reference. */
function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  const credentialId = randomUUID();
  return {
    connectionId: randomUUID(),
    credentialId,
    metadata: {},
    resolveCredential: async (id: string): Promise<string> => {
      if (id !== credentialId) throw new Error('wrong reference');
      return TOKEN;
    },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type RecordedCall = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: string;
};

/** Records every request the client made, and answers from the handler. */
function fixtureFetch(handler: (call: RecordedCall) => Response): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: init.redirect,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

/** Unwraps a connector result or fails the test with the error's shape. */
function value<T>(result: ConnectorResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, received ${JSON.stringify(result.error satisfies ConnectorError)}`);
  return result.value;
}

// -- Store + lifecycle for the service/router describes ----------------------

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const reconnectOff: ReconnectPolicy = {
  enabled: false,
  initialDelayMs: 100,
  maxDelayMs: 200,
  maxAttempts: 2,
  jitterRatio: 0,
};

let directory: string;
let store: Database;
let lifecycle: BackendLifecycleManager;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'notion-gw-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  lifecycle = new BackendLifecycleManager({
    store,
    logger,
    networkPolicy: { allowPrivateNetwork: true },
    reconnect: reconnectOff,
    random: () => 0.5,
  });
});

afterEach(async () => {
  await lifecycle.shutdown();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('notion client', () => {
  it('authenticates against the fixed origin with the pinned headers', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createNotionClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('/v1/users/me');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.notion.com/v1/users/me');
    expect(calls[0]!.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': '2026-03-11',
      Accept: 'application/json',
    });
  });

  it('sends POST bodies as JSON with the declared content type', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createNotionClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.post('/v1/search', { query: 'x' });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.body).toBe('{"query":"x"}');
  });

  it('drops undefined query parameters and keeps the defined ones', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createNotionClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get(`/v1/blocks/${BLOCK_ID}/children`, { page_size: 2, start_cursor: 'opaque-cursor-1' });

    expect(calls[0]!.url).toBe(
      `https://api.notion.com/v1/blocks/${BLOCK_ID}/children?page_size=2&start_cursor=opaque-cursor-1`,
    );
  });

  it('refuses redirects at the fetch level, so no hop can carry the token to another host', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createNotionClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('/v1/users/me');

    // The boundary is enforced by the request itself, not by undici's
    // courtesy of stripping Authorization on cross-origin redirects.
    expect(calls[0]!.redirect).toBe('error');
  });

  it('maps every plain failure status to the connector vocabulary without echoing the token', async () => {
    const cases: Array<{ status: number; kind: string }> = [
      { status: 401, kind: 'reauthorization_required' },
      { status: 400, kind: 'invalid_request' },
      { status: 403, kind: 'invalid_request' },
      { status: 404, kind: 'invalid_request' },
      { status: 406, kind: 'invalid_request' },
      { status: 409, kind: 'invalid_request' },
      { status: 418, kind: 'invalid_request' },
      { status: 500, kind: 'provider_error' },
      { status: 503, kind: 'provider_error' },
      { status: 529, kind: 'provider_error' },
    ];

    for (const { status, kind } of cases) {
      const client = createNotionClient({
        token: TOKEN,
        signal: new AbortController().signal,
        fetchImpl: () => jsonResponse({ object: 'error', code: 'fixture', message: 'fixture' }, status),
      });

      const result = await client.get('/v1/users/me');
      expect(result, `status ${status}`).toMatchObject({ ok: false, error: { kind } });
      expect(JSON.stringify(result), `status ${status}`).not.toContain(TOKEN);
    }
  });

  it('retries exactly once when Retry-After fits the ceiling, then succeeds', async () => {
    let rateLimited = true;
    const { fetch, calls } = fixtureFetch(() => {
      if (rateLimited) {
        rateLimited = false;
        return jsonResponse({}, 429, { 'retry-after': '1' });
      }
      return jsonResponse({ object: 'user', id: 'bot' });
    });
    const sleeps: number[] = [];
    const client = createNotionClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('/v1/users/me');

    expect(result).toMatchObject({ ok: true, value: { object: 'user' } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('gives up after the single bounded retry', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '1' }));
    const sleeps: number[] = [];
    const client = createNotionClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('/v1/users/me');

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry at all when the wait would exceed the ceiling', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '60' }));
    const sleeps: number[] = [];
    const client = createNotionClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('/v1/users/me');

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (result.ok) return;
    // A 60 s wait exceeds the retry ceiling, so the reset fact is surfaced
    // instead of the call sleeping through the caller's budget.
    expect(result.error.message).toContain('too long');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('reports a network failure as unreachable', async () => {
    const client = createNotionClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.get('/v1/users/me')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unreachable' },
    });
  });

  it('refuses a 200 whose body is not valid JSON', async () => {
    const client = createNotionClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () => new Response('<html>not json</html>', { status: 200 }),
    });

    await expect(client.get('/v1/users/me')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'provider_error' },
    });
  });
});

describe('notion tools', () => {
  const schemaOf = (name: string): ReturnType<typeof compileInputSchema> =>
    compileInputSchema(notionToolDefinitions().find((tool) => tool.name === name)!.inputSchema);

  it('advertise schemas the production validator compiles, and reject what the connector refuses', () => {
    for (const tool of notionToolDefinitions()) {
      // Every advertised schema must be compilable: a tool the router would
      // forward unvalidated is a tool whose contract nobody checked.
      expect(compileInputSchema(tool.inputSchema).validate, tool.name).toBeDefined();
    }

    // Only `search` takes no arguments; every identity tool has required ids.
    expect(schemaOf('search').validate!({}).valid).toBe(true);
    for (const name of ['get_page', 'get_block', 'list_block_children', 'get_database', 'query_data_source']) {
      expect(schemaOf(name).validate!({}).valid, name).toBe(false);
    }
  });

  it('accepts both documented id shapes and refuses everything else', () => {
    const dashed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(schemaOf('get_page').validate!({ page_id: PAGE_ID }).valid).toBe(true);
    expect(schemaOf('get_page').validate!({ page_id: dashed }).valid).toBe(true);
    // Free text, path traversal, and unknown keys never reach a URL.
    expect(schemaOf('get_page').validate!({ page_id: 'not-a-uuid' }).valid).toBe(false);
    expect(schemaOf('get_page').validate!({ page_id: '../../v1/users/me' }).valid).toBe(false);
    expect(schemaOf('get_page').validate!({ page_id: PAGE_ID, extra: true }).valid).toBe(false);
  });

  it('bounds pagination and cursors at the documented maxima', () => {
    expect(schemaOf('search').validate!({ page_size: 1 }).valid).toBe(true);
    expect(schemaOf('search').validate!({ page_size: 100 }).valid).toBe(true);
    expect(schemaOf('search').validate!({ page_size: 0 }).valid).toBe(false);
    expect(schemaOf('search').validate!({ page_size: 101 }).valid).toBe(false);
    expect(schemaOf('search').validate!({ page_size: 1.5 }).valid).toBe(false);
    // Cursors are opaque: bounds only, format never enforced.
    expect(schemaOf('search').validate!({ start_cursor: 'c'.repeat(300) }).valid).toBe(true);
    expect(schemaOf('search').validate!({ start_cursor: 'c'.repeat(301) }).valid).toBe(false);
  });

  it('rejects non-enum values and keeps the option sets closed', () => {
    expect(schemaOf('search').validate!({ object_filter: 'page' }).valid).toBe(true);
    expect(schemaOf('search').validate!({ object_filter: 'workspace' }).valid).toBe(false);
    expect(schemaOf('search').validate!({ sort_direction: 'ascending' }).valid).toBe(true);
    expect(schemaOf('search').validate!({ sort_direction: 'up' }).valid).toBe(false);
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, filter: { property: 'Status' } }).valid).toBe(true);
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, filter: 'Status' }).valid).toBe(false);
  });

  it('bounds the query_data_source grammar without inventing one', () => {
    const filterOf = (size: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i]));
    const sort = (property: string) => ({ property, direction: 'ascending' as const });
    const timestampSort = { timestamp: 'last_edited_time', direction: 'descending' as const };

    // Filter size and sorts length are bounded; the internals stay Notion's.
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, filter: filterOf(50) }).valid).toBe(true);
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, filter: filterOf(51) }).valid).toBe(false);
    expect(
      schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, sorts: Array.from({ length: 10 }, (_, i) => sort(`p${i}`)) })
        .valid,
    ).toBe(true);
    expect(
      schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, sorts: Array.from({ length: 11 }, (_, i) => sort(`p${i}`)) })
        .valid,
    ).toBe(false);

    // Both documented sort shapes, and never a mix of the two.
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, sorts: [sort('Due')] }).valid).toBe(true);
    expect(schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, sorts: [timestampSort] }).valid).toBe(true);
    expect(
      schemaOf('query_data_source').validate!({ data_source_id: DATA_SOURCE_ID, sorts: [{ ...sort('Due'), ...timestampSort }] }).valid,
    ).toBe(false);
  });
});

describe('notion connector: discovery', () => {
  it('proves the token once, then lists exactly six read-only tools', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ object: 'user', id: 'bot' }));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const tools = value(await connector.discoverTools!(context()));

    expect(calls.map((call) => call.url)).toEqual(['https://api.notion.com/v1/users/me']);
    expect(tools.map((tool) => tool.name)).toEqual([
      'search',
      'get_page',
      'get_block',
      'list_block_children',
      'get_database',
      'query_data_source',
    ]);
    for (const tool of tools) expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it('refuses to discover without a stored credential and never fetches', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = await connector.discoverTools!(context({ credentialId: null }));

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it('propagates a rejected token as reauthorization_required', async () => {
    const connector = createNotionConnector({
      fetchImpl: () => jsonResponse({ object: 'error', code: 'unauthorized', status: 401 }, 401),
    });

    await expect(connector.discoverTools!(context())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'reauthorization_required' },
    });
  });

  it('resolves the token through the scoped resolver and exposes it only in the header', async () => {
    const credentialId = randomUUID();
    const resolutions: string[] = [];
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ object: 'user', id: 'bot' }));
    const connector: Connector = createNotionConnector({ fetchImpl: fetch });

    await connector.discoverTools!(
      context({
        credentialId,
        resolveCredential: async (id: string) => {
          resolutions.push(id);
          return TOKEN;
        },
      }),
    );

    expect(resolutions).toEqual([credentialId]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('notion connector: execution', () => {
  const richText = (text: string) => [{ type: 'text', text: { content: text }, plain_text: text, annotations: {} }];

  const PAGE = {
    object: 'page',
    id: PAGE_ID,
    created_time: '2026-11-01T10:00:00.000Z',
    last_edited_time: '2026-11-02T11:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-2' },
    cover: null,
    icon: null,
    parent: { type: 'database_id', database_id: DATABASE_ID },
    archived: false,
    in_trash: false,
    properties: {
      Title: { id: '%3Fvw', type: 'title', title: richText('Meeting notes: café ☕') },
      Status: { id: 'sSfd', type: 'status', status: { name: 'Done' } },
      Points: { id: 'pts', type: 'number', number: 42 },
      Tags: { id: 'tags', type: 'multi_select', multi_select: [{ name: 'ops' }, { name: 'infra' }] },
      When: { id: 'when', type: 'date', date: { start: '2026-11-01', end: '2026-11-05' } },
      Done: { id: 'done', type: 'checkbox', checkbox: true },
      Link: { id: 'link', type: 'url', url: 'https://example.com/x' },
      Who: { id: 'who', type: 'people', people: [{ object: 'user', name: 'Ada', id: 'user-3' }] },
      Refs: { id: 'refs', type: 'relation', relation: [{ id: RELATION_ID }] },
      Files: { id: 'files', type: 'files', files: [{ name: 'spec.pdf', type: 'file_external' }] },
      ID: { id: 'uid', type: 'unique_id', unique_id: { prefix: 'TASK', number: 7 } },
      Future: { id: 'fut', type: 'button', button: {} },
    },
    url: 'https://www.notion.so/fixture/Meeting-notes-3f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b',
  };

  const PARAGRAPH = {
    object: 'block',
    id: BLOCK_ID,
    type: 'paragraph',
    created_time: '2026-11-01T10:00:00.000Z',
    last_edited_time: '2026-11-02T11:00:00.000Z',
    has_children: true,
    archived: false,
    in_trash: false,
    // Untrusted surplus: normalization must drop it, not forward it.
    paragraph: { rich_text: richText('Hello 世界'), color: 'gray_background' },
  };

  const UNSUPPORTED = {
    object: 'block',
    id: '8f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b',
    type: 'unsupported',
    has_children: false,
    archived: false,
    in_trash: false,
    unsupported: { block_type: 'column' },
  };

  const FUTURE_BLOCK = {
    object: 'block',
    id: '9f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b',
    type: 'meeting_notes',
    has_children: false,
    archived: false,
    in_trash: false,
    meeting_notes: {},
  };

  it('executes get_page and returns only the closed, rendered shape', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse(PAGE));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'get_page', { page_id: PAGE_ID }));

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/pages/${PAGE_ID}`);
    expect(result.structuredContent).toEqual({
      id: PAGE_ID,
      url: PAGE.url,
      title: 'Meeting notes: café ☕',
      archived: false,
      inTrash: false,
      parent: { type: 'database_id', id: DATABASE_ID },
      createdTime: '2026-11-01T10:00:00.000Z',
      lastEditedTime: '2026-11-02T11:00:00.000Z',
      properties: [
        { name: 'Title', type: 'title', text: 'Meeting notes: café ☕' },
        { name: 'Status', type: 'status', text: 'Done' },
        { name: 'Points', type: 'number', text: '42' },
        { name: 'Tags', type: 'multi_select', text: 'ops, infra' },
        { name: 'When', type: 'date', text: '2026-11-01 to 2026-11-05' },
        { name: 'Done', type: 'checkbox', text: 'true' },
        { name: 'Link', type: 'url', text: 'https://example.com/x' },
        { name: 'Who', type: 'people', text: 'Ada' },
        { name: 'Refs', type: 'relation', text: RELATION_ID },
        { name: 'Files', type: 'files', text: 'spec.pdf' },
        { name: 'ID', type: 'unique_id', text: 'TASK7' },
        // A future property type is recorded with its type and an honest
        // "present but not rendered" null — never silently dropped.
        { name: 'Future', type: 'button', text: null },
      ],
    });
    // The text form carries the same closed payload — nothing raw, nothing extra.
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual(
      result.structuredContent,
    );
    // Raw Notion field names never leave the normalizer.
    expect(JSON.stringify(result)).not.toContain('plain_text');
    expect(JSON.stringify(result)).not.toContain('rich_text');
  });

  it('executes get_block and returns the closed block shape', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse(PARAGRAPH));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'get_block', { block_id: BLOCK_ID }));

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/blocks/${BLOCK_ID}`);
    expect(result.structuredContent).toEqual({
      id: BLOCK_ID,
      type: 'paragraph',
      text: 'Hello 世界',
      hasChildren: true,
      inTrash: false,
      createdTime: '2026-11-01T10:00:00.000Z',
      lastEditedTime: '2026-11-02T11:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('color');
  });

  it('records unsupported and future block types instead of dropping them', async () => {
    const envelope = {
      object: 'list',
      results: [PARAGRAPH, UNSUPPORTED, FUTURE_BLOCK],
      next_cursor: null,
      has_more: false,
    };
    const { fetch } = fixtureFetch(() => jsonResponse(envelope));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'list_block_children', { block_id: BLOCK_ID }));
    const items = (result.structuredContent as { items: Array<{ type: string; text: string | null }> }).items;

    expect(items.map((item) => item.type)).toEqual(['paragraph', 'unsupported', 'meeting_notes']);
    // Notion's own `unsupported` carries the underlying type; a type the
    // gateway has never heard of is still present, with an honest null.
    expect(items[1]!.text).toBe('[unsupported: column]');
    expect(items[2]!.text).toBeNull();
  });

  it('lists block children one page at a time and passes the cursor back verbatim', async () => {
    const { fetch, calls } = fixtureFetch((call) =>
      jsonResponse(
        call.url.includes('start_cursor=opaque-cursor-1')
          ? { object: 'list', results: [PARAGRAPH], next_cursor: null, has_more: false }
          : { object: 'list', results: [PARAGRAPH], next_cursor: 'opaque-cursor-1', has_more: true },
      ),
    );
    const connector = createNotionConnector({ fetchImpl: fetch });

    const first = value(
      await connector.executeTool!(context(), 'list_block_children', { block_id: BLOCK_ID, page_size: 1 }),
    );
    expect(first.structuredContent).toMatchObject({ hasMore: true, nextCursor: 'opaque-cursor-1' });

    // The caller drives continuation; the gateway never loops on its own.
    const second = value(
      await connector.executeTool!(context(), 'list_block_children', {
        block_id: BLOCK_ID,
        page_size: 1,
        start_cursor: 'opaque-cursor-1',
      }),
    );
    expect(second.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
    expect(calls[1]!.url).toBe(
      `https://api.notion.com/v1/blocks/${BLOCK_ID}/children?page_size=1&start_cursor=opaque-cursor-1`,
    );
    expect(calls).toHaveLength(2);
  });

  it('executes search with the documented body mapping, over pages and data sources', async () => {
    const { fetch, calls } = fixtureFetch(() =>
      jsonResponse({
        object: 'list',
        results: [
          {
            object: 'page',
            id: PAGE_ID,
            properties: { Name: { type: 'title', title: richText('Roadmap') } },
            url: 'https://www.notion.so/roadmap',
          },
          {
            object: 'data_source',
            id: DATA_SOURCE_ID,
            title: richText('Q4 tasks'),
            url: 'https://www.notion.so/q4',
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    );
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'search', {
        query: 'tasks',
        object_filter: 'data_source',
        in_trash: true,
        sort_direction: 'ascending',
        page_size: 5,
        start_cursor: 'opaque-cursor-1',
      }),
    );

    expect(calls[0]!.url).toBe('https://api.notion.com/v1/search');
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
      query: 'tasks',
      filter: { property: 'object', value: 'data_source' },
      in_trash: true,
      sort: { direction: 'ascending', timestamp: 'last_edited_time' },
      page_size: 5,
      start_cursor: 'opaque-cursor-1',
    });
    expect(result.structuredContent).toEqual({
      items: [
        { objectType: 'page', id: PAGE_ID, title: 'Roadmap', url: 'https://www.notion.so/roadmap' },
        { objectType: 'data_source', id: DATA_SOURCE_ID, title: 'Q4 tasks', url: 'https://www.notion.so/q4' },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('executes get_database with its queryable data sources', async () => {
    const database = {
      object: 'database',
      id: DATABASE_ID,
      title: richText('Team tasks'),
      description: richText('All the tasks'),
      is_inline: false,
      in_trash: false,
      created_time: '2026-11-01T10:00:00.000Z',
      last_edited_time: '2026-11-02T11:00:00.000Z',
      data_sources: [
        { id: DATA_SOURCE_ID, name: 'All tasks' },
        { id: '0f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b', name: 'This week' },
      ],
      url: 'https://www.notion.so/team-tasks',
    };
    const { fetch, calls } = fixtureFetch(() => jsonResponse(database));
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'get_database', { database_id: DATABASE_ID }));

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/databases/${DATABASE_ID}`);
    expect(result.structuredContent).toEqual({
      id: DATABASE_ID,
      title: 'Team tasks',
      description: 'All the tasks',
      url: 'https://www.notion.so/team-tasks',
      isInline: false,
      inTrash: false,
      createdTime: '2026-11-01T10:00:00.000Z',
      lastEditedTime: '2026-11-02T11:00:00.000Z',
      dataSources: [
        { id: DATA_SOURCE_ID, name: 'All tasks' },
        { id: '0f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b', name: 'This week' },
      ],
    });
  });

  it('executes query_data_source with the filter and sorts passed through bounded', async () => {
    const { fetch, calls } = fixtureFetch(() =>
      jsonResponse({
        object: 'list',
        results: [
          {
            object: 'page',
            id: PAGE_ID,
            created_time: '2026-11-01T10:00:00.000Z',
            last_edited_time: '2026-11-02T11:00:00.000Z',
            properties: { Task: { type: 'title', title: richText('Ship the gateway') } },
            url: 'https://www.notion.so/ship',
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    );
    const connector = createNotionConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'query_data_source', {
        data_source_id: DATA_SOURCE_ID,
        filter: { property: 'Status', status: { equals: 'Done' } },
        sorts: [{ property: 'Due', direction: 'ascending' }],
        page_size: 5,
      }),
    );

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`);
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Due', direction: 'ascending' }],
      page_size: 5,
    });
    expect(result.structuredContent).toEqual({
      items: [
        {
          id: PAGE_ID,
          url: 'https://www.notion.so/ship',
          createdTime: '2026-11-01T10:00:00.000Z',
          lastEditedTime: '2026-11-02T11:00:00.000Z',
          properties: [{ name: 'Task', type: 'title', text: 'Ship the gateway' }],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('defends against malformed arguments even though the router already validates', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createNotionConnector({ fetchImpl: fetch });

    // Missing or non-id arguments on five tools, and a non-object. A
    // wrong-typed pagination value is dropped (GitHub precedent): the
    // advertised schema is the strict gate, the connector stays lenient.
    for (const [tool, args] of [
      ['get_page', { page_id: 'not-a-uuid' }],
      ['get_page', { page_id: '../../v1/users/me' }],
      ['get_block', {}],
      ['get_database', { database_id: 'zzz' }],
      ['query_data_source', { data_source_id: DATA_SOURCE_ID, sorts: 'nope' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await connector.executeTool!(context(), tool, args);
      expect(result, tool).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    }

    await expect(connector.executeTool!(context(), 'search', 'nope')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses a tool name the provider never registered', async () => {
    const connector = createNotionConnector({ fetchImpl: () => jsonResponse({}) });

    await expect(connector.executeTool!(context(), 'create_page', {})).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request', message: 'Unknown Notion tool "create_page".' },
    });
  });

  it('refuses a detail response whose shape was not recognized', async () => {
    const connector = createNotionConnector({ fetchImpl: () => jsonResponse({ unhelpful: true }) });

    const result = await connector.executeTool!(context(), 'get_page', { page_id: PAGE_ID });

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (!result.ok) expect(result.error.message).toContain('shape was not recognized');
  });

  it('surfaces a provider refusal from execution untouched', async () => {
    const connector = createNotionConnector({
      fetchImpl: () =>
        jsonResponse({ object: 'error', code: 'object_not_found', status: 404, message: 'Could not find page' }, 404),
    });

    const result = await connector.executeTool!(context(), 'get_page', { page_id: PAGE_ID });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    if (!result.ok) {
      expect(result.error.message).toContain('404');
      // The provider's prose is untrusted and never echoed.
      expect(result.error.message).not.toContain('Could not find page');
    }
  });
});

describe('notion through the production service', () => {
  /**
   * The real registration, the real connector, the real `IntegrationService`
   * and `ToolCatalog` — only the HTTP seam is a fixture, which is the mock-only
   * ceiling this phase works under. The router seam itself is pinned by
   * `integrations-execution.test.ts` with a fixture connector; the describe
   * below wires the real registration into the real router.
   */
  function service(fetch: FetchLike): { integrations: IntegrationService; catalog: ToolCatalog } {
    const registry = new ProviderRegistry();
    registry.register(notionRegistration, createNotionConnector({ fetchImpl: fetch }));
    const catalog = new ToolCatalog();

    const integrations = new IntegrationService({
      store,
      registry,
      vault: new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') })),
      catalog,
      logger,
      now: () => NOW,
    });
    return { integrations, catalog };
  }

  it('connects through the real handshake and publishes the six tools under the connection namespace', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ object: 'user', id: 'bot' }));
    const { integrations, catalog } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'notion', name: 'fixture-notion', metadata: {} });
    integrations.storeCredential(connection.id, TOKEN);

    const { connection: connected, outcome } = await integrations.connect(connection.id);

    // One handshake call, no more. It proves the token; the workspace the bot
    // user belongs to is deliberately not recorded anywhere.
    expect(calls.map((call) => call.url)).toEqual(['https://api.notion.com/v1/users/me']);
    expect(connected.status).toBe('connected');
    expect(connected.validatedAt).toBe(NOW);

    // The snapshot diff speaks the provider's own names.
    expect(outcome.added).toEqual([
      'get_block',
      'get_database',
      'get_page',
      'list_block_children',
      'query_data_source',
      'search',
    ]);
    // ADR-048 namespacing: what a client calls is `<connection_id>__<tool>`,
    // so a stored name never changes meaning, whoever else connects later.
    expect(catalog.listByConnection(connection.id).map((tool) => tool.publicName)).toEqual([
      `${connection.id}__get_block`,
      `${connection.id}__get_database`,
      `${connection.id}__get_page`,
      `${connection.id}__list_block_children`,
      `${connection.id}__query_data_source`,
      `${connection.id}__search`,
    ]);
    expect(catalog.listByConnection(connection.id).every((tool) => tool.availability === 'available')).toBe(true);
  });

  it('lands a rejected token in `reauthorization_required`, tools unpublished', async () => {
    const { integrations, catalog } = service(() =>
      jsonResponse({ object: 'error', code: 'unauthorized', status: 401 }, 401),
    );

    const connection = integrations.create({ id: randomUUID(), providerId: 'notion', name: 'fixture-notion', metadata: {} });
    integrations.storeCredential(connection.id, TOKEN);

    await expect(integrations.connect(connection.id)).rejects.toMatchObject({ code: 'BACKEND_CONNECTION_ERROR' });

    const refused = integrations.list()[0]!;
    expect(refused.status).toBe('reauthorization_required');
    expect(refused.validatedAt).toBeNull();
    // Nothing to call: the catalog never learned a tool from this connection.
    expect(catalog.listByConnection(connection.id)).toEqual([]);
  });

  it('disconnects without touching the credential: reconnect re-proves the same sealed token', async () => {
    let verified = 0;
    const { fetch } = fixtureFetch(() => {
      verified += 1;
      return jsonResponse({ object: 'user', id: 'bot' });
    });
    const { integrations } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'notion', name: 'fixture-notion', metadata: {} });
    integrations.storeCredential(connection.id, TOKEN);
    await integrations.connect(connection.id);
    const linked = integrations.list()[0]!.credentialId!;

    // The row survives a disconnect; the sealed credential is untouched.
    const disconnected = integrations.disconnect(connection.id);
    expect(disconnected.status).toBe('disconnected');
    expect(disconnected.credentialId).toBe(linked);

    const reconnected = await integrations.connect(connection.id);
    expect(reconnected.connection.status).toBe('connected');
    // The same reference, not a re-stored one: disconnect never deletes.
    expect(reconnected.connection.credentialId).toBe(linked);
    // Two handshakes total: one per connect. Reconnection re-proves the token
    // rather than trusting the previous `connected`.
    expect(verified).toBe(2);
  });
});

describe('notion through the production router', () => {
  const allow = (target: string) =>
    ({ resource: 'tool', target, effect: 'allow' as const }) satisfies Policy['rules'][number];

  const BOT_USER = { object: 'user', id: 'bot-user-id', type: 'bot', name: 'fixture bot' };
  const GH_REPO = {
    id: 1296269,
    name: 'Hello-World',
    full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' },
    visibility: 'public',
    default_branch: 'master',
    description: null,
    html_url: 'https://github.com/octocat/Hello-World',
    updated_at: '2026-01-01T00:00:00Z',
  };

  /**
   * The real registrations — Notion and GitHub — behind the real router, the
   * real authorization service, and the real catalog. One fixture answers
   * every host: the boundary assertions below prove which connection's
   * credential each call actually carried.
   */
  function harness() {
    const { fetch, calls } = fixtureFetch((call) => {
      if (call.url.startsWith('https://api.notion.com/v1/users/me')) return jsonResponse(BOT_USER);
      if (call.url.startsWith('https://api.notion.com/v1/pages/')) {
        return jsonResponse({
          object: 'page',
          id: PAGE_ID,
          parent: { type: 'workspace', workspace: true },
          properties: { Name: { type: 'title', title: [{ plain_text: 'Fixture page' }] } },
          url: 'https://www.notion.so/fixture',
        });
      }
      if (call.url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' });
      if (call.url.startsWith('https://api.github.com/repos/')) return jsonResponse(GH_REPO);
      return jsonResponse({});
    });

    const registry = new ProviderRegistry();
    registry.register(notionRegistration, createNotionConnector({ fetchImpl: fetch }));
    // One fixture answers both hosts; GitHub's fetch shape is leaner (GETs
    // only), so it forwards into the same recording fetch.
    registry.register(
      githubRegistration,
      createGitHubConnector({
        fetchImpl: (url, init) =>
          fetch(url, { method: 'GET', headers: init.headers, signal: init.signal, redirect: init.redirect }),
      }),
    );

    const catalog = new ToolCatalog();
    const integrations = new IntegrationService({
      store,
      registry,
      vault: new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') })),
      catalog,
      logger,
      now: () => NOW,
    });
    const authorization = new AuthorizationService({ store, catalog, logger, now: () => NOW });
    const router = new ToolRouter({ store, logger, lifecycle, catalog, authorization, integrations, timeoutMs: 5_000 });
    const agents = new AgentService(store);
    const policies = new PolicyService({ store });

    async function connect(providerId: string, name: string, token: string) {
      const connection = integrations.create({ id: randomUUID(), providerId, name, metadata: {} });
      integrations.storeCredential(connection.id, token);
      await integrations.connect(connection.id);
      return connection;
    }

    return { fetch, calls, catalog, integrations, router, agents, policies, connect };
  }

  it('isolates two Notion connections and two agents, with GitHub publishing alongside', async () => {
    const { calls, catalog, router, agents, policies, connect } = harness();
    const first = await connect('notion', 'notion-a', 'ntn_connection_a_fixture');
    const second = await connect('notion', 'notion-b', 'ntn_connection_b_fixture');
    const github = await connect('github', 'github-a', 'github_pat_fixture');

    // Eighteen tools, zero collisions: every public name carries its own
    // connection id, so no Notion connection can shadow another, nor GitHub.
    expect(catalog.listAll()).toHaveLength(18);
    expect(new Set(catalog.listAll().map((tool) => tool.publicName)).size).toBe(18);

    // Two agents, each granted exactly one connection's tool.
    const agentOne = agents.create({ name: 'reader-a' });
    policies.assign(agentOne.id, policies.create({ name: 'a-page', rules: [allow(`${first.id}__get_page`)] }).id);
    const agentTwo = agents.create({ name: 'reader-b' });
    policies.assign(agentTwo.id, policies.create({ name: 'b-page', rules: [allow(`${second.id}__get_page`)] }).id);

    // A stranger with no grant gets the unknown-tool answer, and nothing is
    // routed — no request leaves the gateway for an unauthorized caller.
    const before = calls.length;
    const stranger = agents.create({ name: 'stranger' });
    await expect(
      router.call(`${first.id}__get_page`, { page_id: PAGE_ID }, { agent: stranger }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(calls.length).toBe(before);

    // Each agent's call resolves its own connection's sealed credential.
    const routedOne = await router.call(`${first.id}__get_page`, { page_id: PAGE_ID }, { agent: agentOne, requestId: 'req-a' });
    expect(routedOne.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: first.id });

    const routedTwo = await router.call(`${second.id}__get_page`, { page_id: PAGE_ID }, { agent: agentTwo, requestId: 'req-b' });
    expect(routedTwo.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: second.id });

    // A policy is per tool: agent one cannot borrow agent two's connection.
    await expect(
      router.call(`${second.id}__get_page`, { page_id: PAGE_ID }, { agent: agentOne }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });

    // Two connections, two sealed tokens: each call carried its own.
    const pageCalls = calls.filter((call) => call.url.startsWith('https://api.notion.com/v1/pages/'));
    expect(pageCalls).toHaveLength(2);
    expect(pageCalls[0]!.headers.Authorization).toBe('Bearer ntn_connection_a_fixture');
    expect(pageCalls[1]!.headers.Authorization).toBe('Bearer ntn_connection_b_fixture');

    // GitHub publishes alongside without collision, and routes through the
    // same managed seam — a managed call names no backend.
    const agentThree = agents.create({ name: 'gh-reader' });
    policies.assign(agentThree.id, policies.create({ name: 'gh', rules: [allow(`${github.id}__get_repository`)] }).id);
    const routed = await router.call(`${github.id}__get_repository`, { owner: 'octocat', repo: 'hello-world' }, { agent: agentThree });
    expect(routed.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: github.id });

    // The activity rows name the connection, not a backend, and only the
    // three authorized calls were ever dispatched.
    const rows = store.activity.list(50).filter((event) => event.type === 'tools.call');
    expect(rows).toHaveLength(3);
    const rowOne = rows.find((row) => row.toolName === `${first.id}__get_page`);
    expect(rowOne).toMatchObject({ connectionId: first.id, outcome: 'success', requestId: 'req-a' });
    expect(rowOne?.backendId).toBeUndefined();
    expect(rows.find((row) => row.toolName === `${github.id}__get_repository`)).toMatchObject({
      connectionId: github.id,
      outcome: 'success',
    });
  });
});
