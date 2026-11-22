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
import { ProviderRegistry, githubRegistration, notionRegistration, slackRegistration } from '../src/integrations/registry.js';
import { IntegrationService } from '../src/integrations/service.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';
import { createGitHubConnector } from '../src/integrations/github/connector.js';
import { createNotionConnector } from '../src/integrations/notion/connector.js';
import { createSlackClient, type FetchLike } from '../src/integrations/slack/client.js';
import { createSlackConnector } from '../src/integrations/slack/connector.js';
import { slackToolDefinitions } from '../src/integrations/slack/tools.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { PolicyService } from '../src/registry/policy-service.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { ToolCatalog } from '../src/routing/catalog.js';
import { ToolRouter } from '../src/routing/router.js';
import { compileInputSchema } from '../src/routing/schema.js';

/**
 * The Slack provider against fixture HTTP responses (ADR-056). No request
 * leaves the process: every fetch and every sleep is injected, and the
 * negative assertions pin the boundaries — the token never travels outside
 * the Authorization header, Slack's signature failure shape (**HTTP 200 with
 * `ok: false`**) is treated as the failure it is, and `ts` values survive as
 * exact strings because they are ids, not numbers.
 *
 * The last two describes drive the real `IntegrationService`, the real
 * `ToolCatalog`, and the real `ToolRouter` with the real registration — only
 * the HTTP seam is a fixture — including two Slack connections, two agents,
 * and Notion and GitHub connections publishing alongside.
 */

const TOKEN = 'xoxb-fixture-only-never-real-token';
const NOW = '2026-11-23T00:00:00.000Z';

// Legal Slack ids: C channel, G private group/mpim, D direct message.
const CHANNEL_ID = 'C0123ABCD45';
const PRIVATE_GROUP_ID = 'G0123ABCD45';
const DM_ID = 'D0123ABCD45';
const USER_ID = 'U0123ABCD45';
const BOT_ID = 'B0123ABCD45';
/** A message timestamp id, microseconds and all. */
const TS = '1758931200.000123';
const THREAD_TS = '1758931200.000100';
const PAGE_ID = '3f5e7a9c1b2d4e6f8a0b2c4d6e8f0a2b';

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
  directory = mkdtempSync(join(tmpdir(), 'slack-gw-'));
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

describe('slack client', () => {
  it('authenticates against the fixed origin with the pinned headers', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createSlackClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('conversations.info', { channel: CHANNEL_ID });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://slack.com/api/conversations.info?channel=${CHANNEL_ID}`);
    expect(calls[0]!.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    });
  });

  it('sends POST bodies as JSON with the declared content type', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createSlackClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.post('auth.test');

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://slack.com/api/auth.test');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.body).toBe('{}');
  });

  it('drops undefined query parameters and keeps the defined ones', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createSlackClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('conversations.list', { types: 'public_channel,private_channel', limit: 50, cursor: 'opaque-cursor-1' });

    expect(calls[0]!.url).toBe(
      'https://slack.com/api/conversations.list?types=public_channel%2Cprivate_channel&limit=50&cursor=opaque-cursor-1',
    );
  });

  it('refuses redirects at the fetch level, so no hop can carry the token to another host', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createSlackClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('conversations.list');

    // The boundary is enforced by the request itself, not by undici's
    // courtesy of stripping Authorization on cross-origin redirects.
    expect(calls[0]!.redirect).toBe('error');
  });

  it('treats HTTP 200 with ok:false as the failure it is', async () => {
    const cases: Array<{ code: string | null; kind: string }> = [
      // The credential family: the connection must be reauthorized.
      { code: 'not_authed', kind: 'reauthorization_required' },
      { code: 'invalid_auth', kind: 'reauthorization_required' },
      { code: 'account_inactive', kind: 'reauthorization_required' },
      { code: 'token_expired', kind: 'reauthorization_required' },
      { code: 'token_revoked', kind: 'reauthorization_required' },
      { code: 'missing_scope', kind: 'reauthorization_required' },
      // The request family: this call, not the connection, is wrong.
      { code: 'channel_not_found', kind: 'invalid_request' },
      { code: 'user_not_found', kind: 'invalid_request' },
      { code: 'not_in_channel', kind: 'invalid_request' },
      { code: 'invalid_arguments', kind: 'invalid_request' },
      { code: 'invalid_cursor', kind: 'invalid_request' },
      { code: 'invalid_ts', kind: 'invalid_request' },
      // Slack's own problems, and codes the gateway has never heard of.
      { code: 'ratelimited', kind: 'provider_error' },
      { code: 'internal_error', kind: 'provider_error' },
      { code: 'fatal_error', kind: 'provider_error' },
      { code: 'code_from_the_future', kind: 'provider_error' },
      // No error code at all: still an app-level failure, never a success.
      { code: null, kind: 'provider_error' },
    ];

    for (const { code, kind } of cases) {
      const body = code === null ? { ok: false } : { ok: false, error: code };
      const client = createSlackClient({
        token: TOKEN,
        signal: new AbortController().signal,
        fetchImpl: () => jsonResponse(body),
      });

      const result = await client.get('conversations.list');
      expect(result, code ?? 'no code').toMatchObject({ ok: false, error: { kind } });
      // The token never appears in a failure, and the code — a closed
      // vocabulary, not prose — is quoted so an operator can act on it.
      expect(JSON.stringify(result), code ?? 'no code').not.toContain(TOKEN);
      if (code !== null) {
        if (!result.ok) expect(result.error.message, code).toContain(code);
      }
    }
  });

  it('returns the full body only when both the transport and ok agree', async () => {
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () => jsonResponse({ ok: true, channels: [], response_metadata: { next_cursor: '' } }),
    });

    await expect(client.get('conversations.list')).resolves.toMatchObject({
      ok: true,
      value: { ok: true, channels: [] },
    });
  });

  it('maps every plain failure status to the connector vocabulary without echoing the token', async () => {
    const cases: Array<{ status: number; kind: string }> = [
      { status: 401, kind: 'reauthorization_required' },
      { status: 400, kind: 'invalid_request' },
      { status: 403, kind: 'invalid_request' },
      { status: 404, kind: 'invalid_request' },
      { status: 418, kind: 'invalid_request' },
      { status: 500, kind: 'provider_error' },
      { status: 503, kind: 'provider_error' },
    ];

    for (const { status, kind } of cases) {
      const client = createSlackClient({
        token: TOKEN,
        signal: new AbortController().signal,
        fetchImpl: () => jsonResponse({ ok: false, error: 'fixture' }, status),
      });

      const result = await client.get('conversations.list');
      expect(result, `status ${status}`).toMatchObject({ ok: false, error: { kind } });
      expect(JSON.stringify(result), `status ${status}`).not.toContain(TOKEN);
    }
  });

  it('retries exactly once when Retry-After fits the ceiling, then succeeds', async () => {
    let rateLimited = true;
    const { fetch, calls } = fixtureFetch(() => {
      if (rateLimited) {
        rateLimited = false;
        return jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' });
      }
      return jsonResponse({ ok: true, channels: [] });
    });
    const sleeps: number[] = [];
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('conversations.list');

    expect(result).toMatchObject({ ok: true, value: { channels: [] } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('gives up after the single bounded retry', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' }));
    const sleeps: number[] = [];
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('conversations.list');

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry at all when the wait would exceed the ceiling', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '60' }));
    const sleeps: number[] = [];
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('conversations.list');

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (result.ok) return;
    // A 60 s wait exceeds the retry ceiling, so the reset fact is surfaced
    // instead of the call sleeping through the caller's budget.
    expect(result.error.message).toContain('too long');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('reports a network failure as unreachable', async () => {
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.get('conversations.list')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unreachable' },
    });
  });

  it('refuses a 200 whose body is not valid JSON', async () => {
    const client = createSlackClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () => new Response('<html>not json</html>', { status: 200 }),
    });

    await expect(client.get('conversations.list')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'provider_error' },
    });
  });
});

describe('slack tools', () => {
  const schemaOf = (name: string): ReturnType<typeof compileInputSchema> =>
    compileInputSchema(slackToolDefinitions().find((tool) => tool.name === name)!.inputSchema);

  it('advertise schemas the production validator compiles, and reject what the connector refuses', () => {
    for (const tool of slackToolDefinitions()) {
      // Every advertised schema must be compilable: a tool the router would
      // forward unvalidated is a tool whose contract nobody checked.
      expect(compileInputSchema(tool.inputSchema).validate, tool.name).toBeDefined();
    }

    // Only `list_conversations` takes no arguments; every identity tool has
    // a required id.
    expect(schemaOf('list_conversations').validate!({}).valid).toBe(true);
    for (const name of ['get_conversation_info', 'get_conversation_history', 'get_thread_replies', 'get_user_info']) {
      expect(schemaOf(name).validate!({}).valid, name).toBe(false);
    }
  });

  it('accepts every documented id shape and refuses everything else', () => {
    // Conversation ids across all three kinds.
    for (const id of [CHANNEL_ID, PRIVATE_GROUP_ID, DM_ID]) {
      expect(schemaOf('get_conversation_info').validate!({ channel: id }).valid, id).toBe(true);
    }
    // Free text, path traversal, and unknown keys never reach a URL.
    expect(schemaOf('get_conversation_info').validate!({ channel: 'not-an-id' }).valid).toBe(false);
    expect(schemaOf('get_conversation_info').validate!({ channel: '../../conversations.list' }).valid).toBe(false);
    expect(schemaOf('get_conversation_info').validate!({ channel: CHANNEL_ID, extra: true }).valid).toBe(false);
    expect(schemaOf('get_conversation_info').validate!({ channel: 'xoxb-inject' }).valid).toBe(false);

    // User ids in both documented families.
    expect(schemaOf('get_user_info').validate!({ user: USER_ID }).valid).toBe(true);
    expect(schemaOf('get_user_info').validate!({ user: 'W0123ABCD45' }).valid).toBe(true);
    expect(schemaOf('get_user_info').validate!({ user: CHANNEL_ID }).valid).toBe(false);
    expect(schemaOf('get_user_info').validate!({ user: 'not-a-user' }).valid).toBe(false);
  });

  it('treats timestamps as string ids: exact pattern, never a number', () => {
    expect(schemaOf('get_thread_replies').validate!({ channel: CHANNEL_ID, ts: TS }).valid).toBe(true);
    expect(schemaOf('get_thread_replies').validate!({ channel: CHANNEL_ID, ts: '1758931200' }).valid).toBe(true);
    // A bare epoch seconds value is too short to be a message ts id; float
    // and garbage forms are refused outright.
    expect(schemaOf('get_thread_replies').validate!({ channel: CHANNEL_ID, ts: '175893120' }).valid).toBe(false);
    expect(schemaOf('get_thread_replies').validate!({ channel: CHANNEL_ID, ts: 'not-a-ts' }).valid).toBe(false);
    expect(schemaOf('get_thread_replies').validate!({ channel: CHANNEL_ID, ts: 1758931200.000123 }).valid).toBe(false);
  });

  it('bounds pagination and cursors at the documented maxima', () => {
    expect(schemaOf('list_conversations').validate!({ limit: 1 }).valid).toBe(true);
    expect(schemaOf('list_conversations').validate!({ limit: 200 }).valid).toBe(true);
    expect(schemaOf('list_conversations').validate!({ limit: 0 }).valid).toBe(false);
    expect(schemaOf('list_conversations').validate!({ limit: 201 }).valid).toBe(false);
    expect(schemaOf('list_conversations').validate!({ limit: 1.5 }).valid).toBe(false);
    // Cursors are opaque: bounds only, format never enforced.
    expect(schemaOf('list_conversations').validate!({ cursor: 'c'.repeat(300) }).valid).toBe(true);
    expect(schemaOf('list_conversations').validate!({ cursor: 'c'.repeat(301) }).valid).toBe(false);
  });

  it('keeps the conversation-type option set closed', () => {
    expect(schemaOf('list_conversations').validate!({ types: ['public_channel'] }).valid).toBe(true);
    expect(
      schemaOf('list_conversations').validate!({ types: ['public_channel', 'private_channel', 'mpim', 'im'] }).valid,
    ).toBe(true);
    // Not a string, not an enum member, not unique, too long.
    expect(schemaOf('list_conversations').validate!({ types: 'public_channel' }).valid).toBe(false);
    expect(schemaOf('list_conversations').validate!({ types: ['workspace'] }).valid).toBe(false);
    expect(schemaOf('list_conversations').validate!({ types: ['im', 'im'] }).valid).toBe(false);
    expect(schemaOf('list_conversations').validate!({ types: ['im', 'mpim', 'public_channel', 'private_channel', 'im'] }).valid).toBe(false);
  });
});

describe('slack connector: discovery', () => {
  it('proves the token once with auth.test, then lists exactly five read-only tools', async () => {
    const { fetch, calls } = fixtureFetch(() =>
      jsonResponse({ ok: true, url: 'https://fixture.slack.com/', team: 'Fixture', user: 'fixture-bot', team_id: 'T0123ABCD45', bot_id: BOT_ID }),
    );
    const connector = createSlackConnector({ fetchImpl: fetch });

    const tools = value(await connector.discoverTools!(context()));

    // The handshake is one POST; the workspace identity it returns is
    // deliberately not recorded anywhere.
    expect(calls.map((call) => call.url)).toEqual(['https://slack.com/api/auth.test']);
    expect(calls[0]!.method).toBe('POST');
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_conversations',
      'get_conversation_info',
      'get_conversation_history',
      'get_thread_replies',
      'get_user_info',
    ]);
    for (const tool of tools) expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it('refuses a non-bot token before any request leaves the gateway', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ ok: true }));
    const connector = createSlackConnector({ fetchImpl: fetch });

    // A user token would pass auth.test yet miss every scope the tools need;
    // the registration is for bot tokens, so the prefix is checked first.
    const result = await connector.discoverTools!(
      context({ resolveCredential: async () => 'xoxp-fixture-user-token' }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    if (!result.ok) expect(result.error.message).toContain('xoxb');
    expect(calls).toEqual([]);
  });

  it('refuses to discover without a stored credential and never fetches', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createSlackConnector({ fetchImpl: fetch });

    const result = await connector.discoverTools!(context({ credentialId: null }));

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it('propagates a rejected token as reauthorization_required', async () => {
    const connector = createSlackConnector({
      fetchImpl: () => jsonResponse({ ok: false, error: 'not_authed' }),
    });

    await expect(connector.discoverTools!(context())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'reauthorization_required' },
    });
  });

  it('resolves the token through the scoped resolver and exposes it only in the header', async () => {
    const credentialId = randomUUID();
    const resolutions: string[] = [];
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ ok: true, team_id: 'T0123ABCD45', bot_id: BOT_ID }));
    const connector: Connector = createSlackConnector({ fetchImpl: fetch });

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

describe('slack connector: execution', () => {
  const CHANNEL = {
    id: CHANNEL_ID,
    name: 'general',
    is_channel: true,
    created: 1_735_689_600,
    creator: USER_ID,
    is_archived: false,
    is_private: false,
    num_members: 42,
    topic: { value: 'Gateway talk', creator: USER_ID, last_set: 1_735_689_600 },
    purpose: { value: 'Company-wide', creator: USER_ID, last_set: 1_735_689_600 },
    untrusted_surplus: 'never forwarded',
  };

  const DM = { id: DM_ID, is_im: true, is_private: true, is_archived: false, created: 1_735_689_601, user: USER_ID };

  const MESSAGES = {
    ok: true,
    messages: [
      {
        ts: TS,
        thread_ts: THREAD_TS,
        user: USER_ID,
        text: 'The parent of the thread',
        reply_count: 2,
        latest_reply: '1758931299.000456',
        reactions: [{ name: 'eyes', count: 3 }],
        edited: { ts: '1758931250.000000', user: USER_ID },
      },
      { ts: '1758931300.000456', bot_id: BOT_ID, text: 'A bot said something', subtype: 'bot_message' },
      { ts: '1758931400.000789', user: USER_ID, text: 'Unheard subtype', subtype: 'future_subtype_x' },
    ],
    has_more: true,
    response_metadata: { next_cursor: 'opaque-cursor-2' },
  };

  it('executes list_conversations and returns only the closed shape, one page per call', async () => {
    const body = {
      ok: true,
      channels: [CHANNEL, { ...DM, untrusted_surplus: 'drop me' }, 'not-an-object', { no_id_at_all: true }],
      response_metadata: { next_cursor: 'opaque-cursor-1' },
    };
    const { fetch, calls } = fixtureFetch((call) =>
      jsonResponse(
        call.url.includes('cursor=opaque-cursor-1')
          ? { ok: true, channels: [CHANNEL], response_metadata: { next_cursor: '' } }
          : body,
      ),
    );
    const connector = createSlackConnector({ fetchImpl: fetch });

    const first = value(
      await connector.executeTool!(context(), 'list_conversations', {
        types: ['public_channel', 'private_channel', 'im'],
        limit: 50,
      }),
    );

    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.list?types=public_channel%2Cprivate_channel%2Cim&limit=50');
    expect(first.structuredContent).toMatchObject({ hasMore: true, nextCursor: 'opaque-cursor-1' });
    const items = (first.structuredContent as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: CHANNEL_ID,
      name: 'general',
      kind: 'channel',
      isPrivate: false,
      isArchived: false,
      creator: USER_ID,
      createdTime: '2025-01-01T00:00:00.000Z',
      numMembers: 42,
      topic: 'Gateway talk',
      purpose: 'Company-wide',
    });
    expect(items[1]).toMatchObject({ id: DM_ID, kind: 'im', name: null, numMembers: null });
    // Raw Slack field names never leave the normalizer.
    expect(JSON.stringify(first)).not.toContain('num_members');
    expect(JSON.stringify(first)).not.toContain('untrusted_surplus');
    expect(JSON.stringify(first)).not.toContain('last_set');

    // The caller drives continuation; the gateway never loops on its own.
    // An exhausted list answers with an empty cursor, which reads as "done".
    const second = value(
      await connector.executeTool!(context(), 'list_conversations', { cursor: 'opaque-cursor-1' }),
    );
    expect(second.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
    expect(calls).toHaveLength(2);
  });

  it('executes get_conversation_info for a channel and a DM', async () => {
    const { fetch, calls } = fixtureFetch((call) =>
      jsonResponse(call.url.includes(`channel=${DM_ID}`) ? { ok: true, channel: DM } : { ok: true, channel: CHANNEL }),
    );
    const connector = createSlackConnector({ fetchImpl: fetch });

    const channel = value(await connector.executeTool!(context(), 'get_conversation_info', { channel: CHANNEL_ID }));
    expect(calls[0]!.url).toBe(`https://slack.com/api/conversations.info?channel=${CHANNEL_ID}`);
    expect(channel.structuredContent).toEqual({
      id: CHANNEL_ID,
      name: 'general',
      kind: 'channel',
      isPrivate: false,
      isArchived: false,
      creator: USER_ID,
      createdTime: '2025-01-01T00:00:00.000Z',
      numMembers: 42,
      topic: 'Gateway talk',
      purpose: 'Company-wide',
    });

    const dm = value(await connector.executeTool!(context(), 'get_conversation_info', { channel: DM_ID }));
    expect(dm.structuredContent).toEqual({
      id: DM_ID,
      name: null,
      kind: 'im',
      isPrivate: true,
      isArchived: false,
      creator: null,
      createdTime: '2025-01-01T00:00:01.000Z',
      numMembers: null,
      topic: null,
      purpose: null,
    });
  });

  it('executes get_conversation_history, preserving ts values as exact strings', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse(MESSAGES));
    const connector = createSlackConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'get_conversation_history', { channel: CHANNEL_ID, limit: 50 }),
    );

    expect(calls[0]!.url).toBe(`https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&limit=50`);
    expect(result.structuredContent).toMatchObject({ hasMore: true, nextCursor: 'opaque-cursor-2' });
    const items = (result.structuredContent as { items: unknown[] }).items;
    expect(items).toHaveLength(3);

    // A ts is an id (epoch.microseconds): it survives byte-for-byte, never
    // through a float. thread_ts and latest_reply follow the same rule.
    const parent = items[0] as Record<string, unknown>;
    expect(parent.ts).toBe(TS);
    expect(parent.threadTs).toBe(THREAD_TS);
    expect(parent.latestReply).toBe('1758931299.000456');
    expect(parent).toEqual({
      ts: TS,
      threadTs: THREAD_TS,
      user: USER_ID,
      botId: null,
      text: 'The parent of the thread',
      subtype: null,
      replyCount: 2,
      latestReply: '1758931299.000456',
      isEdited: true,
    });

    const botMessage = items[1] as Record<string, unknown>;
    expect(botMessage.user).toBeNull();
    expect(botMessage.botId).toBe(BOT_ID);
    expect(botMessage.subtype).toBe('bot_message');
    expect(botMessage.isEdited).toBe(false);

    // A subtype the gateway has never heard of is recorded, not dropped.
    const future = items[2] as Record<string, unknown>;
    expect(future.subtype).toBe('future_subtype_x');

    // Reactions and raw field names never leave the normalizer.
    expect(JSON.stringify(result)).not.toContain('reactions');
    expect(JSON.stringify(result)).not.toContain('reply_count');
    expect(JSON.stringify(result)).toContain(`"ts":"${TS}"`);
  });

  it('executes get_thread_replies with the parent ts passed verbatim', async () => {
    const replies = {
      ok: true,
      messages: [
        { ts: '1758931205.000111', thread_ts: THREAD_TS, user: USER_ID, text: 'First reply' },
        { ts: '1758931210.000222', thread_ts: THREAD_TS, user: USER_ID, text: 'Second reply' },
      ],
      has_more: false,
      response_metadata: { next_cursor: '' },
    };
    const { fetch, calls } = fixtureFetch(() => jsonResponse(replies));
    const connector = createSlackConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'get_thread_replies', {
        channel: CHANNEL_ID,
        ts: THREAD_TS,
        limit: 100,
        cursor: 'opaque-cursor-1',
      }),
    );

    expect(calls[0]!.url).toBe(
      `https://slack.com/api/conversations.replies?channel=${CHANNEL_ID}&ts=${THREAD_TS}&limit=100&cursor=opaque-cursor-1`,
    );
    expect(result.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
    const items = (result.structuredContent as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((item) => (item as Record<string, unknown>).threadTs === THREAD_TS)).toBe(true);
  });

  it('executes get_user_info without ever surfacing an email', async () => {
    const body = {
      ok: true,
      user: {
        id: USER_ID,
        team_id: 'T0123ABCD45',
        name: 'ada',
        deleted: false,
        real_name: 'Ada Lovelace',
        is_bot: false,
        profile: {
          display_name: 'ada',
          display_name_normalized: 'Ada',
          // Present in the response only because fixtures are generous; the
          // gateway never requests the scope that earns this field, and the
          // normalizer never reads it.
          email: 'ada@example.com',
          title: 'engineer',
        },
      },
    };
    const { fetch, calls } = fixtureFetch(() => jsonResponse(body));
    const connector = createSlackConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'get_user_info', { user: USER_ID }));

    expect(calls[0]!.url).toBe(`https://slack.com/api/users.info?user=${USER_ID}`);
    expect(result.structuredContent).toEqual({
      id: USER_ID,
      name: 'ada',
      realName: 'Ada Lovelace',
      displayName: 'Ada',
      isBot: false,
      isDeleted: false,
      teamId: 'T0123ABCD45',
    });
    expect(JSON.stringify(result)).not.toContain('email');
    expect(JSON.stringify(result)).not.toContain('profile');
    expect(JSON.stringify(result)).not.toContain('title');
  });

  it('defends against malformed arguments even though the router already validates', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createSlackConnector({ fetchImpl: fetch });

    // Missing or wrong-typed identity arguments on four tools, a traversal
    // attempt, a channel id where a user id belongs, and a non-object. A
    // wrong-typed pagination value is dropped (GitHub/Notion precedent): the
    // advertised schema is the strict gate, the connector stays lenient.
    for (const [tool, args] of [
      ['get_conversation_info', { channel: 'not-an-id' }],
      ['get_conversation_info', { channel: '../../conversations.list' }],
      ['get_conversation_history', {}],
      ['get_thread_replies', { channel: CHANNEL_ID }],
      ['get_thread_replies', { channel: CHANNEL_ID, ts: 'not-a-ts' }],
      ['get_user_info', { user: CHANNEL_ID }],
      ['list_conversations', { types: 'public_channel' }],
      ['list_conversations', { types: [] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await connector.executeTool!(context(), tool, args);
      expect(result, tool).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    }

    await expect(connector.executeTool!(context(), 'list_conversations', 'nope')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses a tool name the provider never registered', async () => {
    const connector = createSlackConnector({ fetchImpl: () => jsonResponse({}) });

    await expect(connector.executeTool!(context(), 'post_message', {})).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request', message: 'Unknown Slack tool "post_message".' },
    });
  });

  it('refuses a response whose shape was not recognized', async () => {
    const connector = createSlackConnector({ fetchImpl: () => jsonResponse({ ok: true, unhelpful: true }) });

    const result = await connector.executeTool!(context(), 'get_conversation_info', { channel: CHANNEL_ID });

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (!result.ok) expect(result.error.message).toContain('shape was not recognized');
  });

  it('surfaces an ok:false refusal from execution as invalid_request', async () => {
    const connector = createSlackConnector({
      fetchImpl: () => jsonResponse({ ok: false, error: 'channel_not_found' }),
    });

    const result = await connector.executeTool!(context(), 'get_conversation_info', { channel: CHANNEL_ID });

    // HTTP 200, and still a failure: both halves of the envelope were read.
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    if (!result.ok) expect(result.error.message).toContain('channel_not_found');
  });

  it('surfaces an ok:false missing scope as reauthorization_required', async () => {
    const connector = createSlackConnector({
      fetchImpl: () => jsonResponse({ ok: false, error: 'missing_scope', needed: 'channels:history' }),
    });

    const result = await connector.executeTool!(context(), 'get_conversation_history', { channel: CHANNEL_ID });

    expect(result).toMatchObject({ ok: false, error: { kind: 'reauthorization_required' } });
    if (!result.ok) {
      expect(result.error.message).toContain('missing_scope');
      // The needed-scope detail is Slack's own prose-shaped field: never echoed.
      expect(result.error.message).not.toContain('channels:history');
    }
  });
});

describe('slack through the production service', () => {
  /**
   * The real registration, the real connector, the real `IntegrationService`
   * and `ToolCatalog` — only the HTTP seam is a fixture, which is the mock-only
   * ceiling this phase works under. The router seam itself is pinned by
   * `integrations-execution.test.ts` with a fixture connector; the describe
   * below wires the real registration into the real router.
   */
  function service(fetch: FetchLike): { integrations: IntegrationService; catalog: ToolCatalog } {
    const registry = new ProviderRegistry();
    registry.register(slackRegistration, createSlackConnector({ fetchImpl: fetch }));
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

  it('connects through the real handshake and publishes the five tools under the connection namespace', async () => {
    const { fetch, calls } = fixtureFetch(() =>
      jsonResponse({ ok: true, url: 'https://fixture.slack.com/', team: 'Fixture', user: 'fixture-bot', team_id: 'T0123ABCD45', bot_id: BOT_ID }),
    );
    const { integrations, catalog } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'slack', name: 'fixture-slack', metadata: {} });
    integrations.storeCredential(connection.id, TOKEN);

    const { connection: connected, outcome } = await integrations.connect(connection.id);

    // One handshake POST, no more. It proves the token; the workspace identity
    // it returns is deliberately not recorded anywhere.
    expect(calls.map((call) => call.url)).toEqual(['https://slack.com/api/auth.test']);
    expect(connected.status).toBe('connected');
    expect(connected.validatedAt).toBe(NOW);

    // The snapshot diff speaks the provider's own names.
    expect(outcome.added).toEqual([
      'get_conversation_history',
      'get_conversation_info',
      'get_thread_replies',
      'get_user_info',
      'list_conversations',
    ]);
    // ADR-048 namespacing: what a client calls is `<connection_id>__<tool>`,
    // so a stored name never changes meaning, whoever else connects later.
    expect(catalog.listByConnection(connection.id).map((tool) => tool.publicName)).toEqual([
      `${connection.id}__get_conversation_history`,
      `${connection.id}__get_conversation_info`,
      `${connection.id}__get_thread_replies`,
      `${connection.id}__get_user_info`,
      `${connection.id}__list_conversations`,
    ]);
    expect(catalog.listByConnection(connection.id).every((tool) => tool.availability === 'available')).toBe(true);
  });

  it('lands a rejected token in `reauthorization_required`, tools unpublished', async () => {
    const { integrations, catalog } = service(() => jsonResponse({ ok: false, error: 'not_authed' }));

    const connection = integrations.create({ id: randomUUID(), providerId: 'slack', name: 'fixture-slack', metadata: {} });
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
      return jsonResponse({ ok: true, team_id: 'T0123ABCD45', bot_id: BOT_ID });
    });
    const { integrations } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'slack', name: 'fixture-slack', metadata: {} });
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

describe('slack through the production router', () => {
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
  const MESSAGES = {
    ok: true,
    messages: [{ ts: TS, user: USER_ID, text: 'fixture message' }],
    has_more: false,
    response_metadata: { next_cursor: '' },
  };

  /**
   * The real registrations — Slack, Notion, and GitHub — behind the real
   * router, the real authorization service, and the real catalog. One
   * fixture answers every host: the boundary assertions below prove which
   * connection's credential each call actually carried.
   */
  function harness() {
    const { fetch, calls } = fixtureFetch((call) => {
      if (call.url === 'https://slack.com/api/auth.test') {
        return jsonResponse({ ok: true, team_id: 'T0123ABCD45', bot_id: BOT_ID });
      }
      if (call.url.startsWith('https://slack.com/api/conversations.history')) return jsonResponse(MESSAGES);
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
      return jsonResponse({ ok: true });
    });

    const registry = new ProviderRegistry();
    registry.register(slackRegistration, createSlackConnector({ fetchImpl: fetch }));
    // One fixture answers all three hosts; GitHub's fetch shape is leaner
    // (GETs only), so it forwards into the same recording fetch.
    registry.register(notionRegistration, createNotionConnector({ fetchImpl: fetch }));
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

  it('isolates two Slack connections and two agents, with Notion and GitHub publishing alongside', async () => {
    const { calls, catalog, router, agents, policies, connect } = harness();
    const first = await connect('slack', 'slack-a', 'xoxb-connection-a-fixture');
    const second = await connect('slack', 'slack-b', 'xoxb-connection-b-fixture');
    const notion = await connect('notion', 'notion-a', 'ntn_connection_fixture');
    const github = await connect('github', 'github-a', 'github_pat_fixture');

    // Twenty-two tools, zero collisions: every public name carries its own
    // connection id, so no Slack workspace can shadow another, nor Notion,
    // nor GitHub.
    expect(catalog.listAll()).toHaveLength(22);
    expect(new Set(catalog.listAll().map((tool) => tool.publicName)).size).toBe(22);

    // Two agents, each granted exactly one connection's tool.
    const agentOne = agents.create({ name: 'reader-a' });
    policies.assign(agentOne.id, policies.create({ name: 'a-history', rules: [allow(`${first.id}__get_conversation_history`)] }).id);
    const agentTwo = agents.create({ name: 'reader-b' });
    policies.assign(agentTwo.id, policies.create({ name: 'b-history', rules: [allow(`${second.id}__get_conversation_history`)] }).id);

    // A stranger with no grant gets the unknown-tool answer, and nothing is
    // routed — no request leaves the gateway for an unauthorized caller.
    const before = calls.length;
    const stranger = agents.create({ name: 'stranger' });
    await expect(
      router.call(`${first.id}__get_conversation_history`, { channel: CHANNEL_ID }, { agent: stranger }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(calls.length).toBe(before);

    // Each agent's call resolves its own connection's sealed credential.
    const routedOne = await router.call(
      `${first.id}__get_conversation_history`,
      { channel: CHANNEL_ID },
      { agent: agentOne, requestId: 'req-a' },
    );
    expect(routedOne.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: first.id });

    const routedTwo = await router.call(
      `${second.id}__get_conversation_history`,
      { channel: CHANNEL_ID },
      { agent: agentTwo, requestId: 'req-b' },
    );
    expect(routedTwo.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: second.id });

    // A policy is per tool: agent one cannot borrow agent two's connection.
    await expect(
      router.call(`${second.id}__get_conversation_history`, { channel: CHANNEL_ID }, { agent: agentOne }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });

    // Two workspaces, two sealed tokens: each call carried its own, and the
    // identity the handshake returned never became the connection's identity.
    const historyCalls = calls.filter((call) => call.url.startsWith('https://slack.com/api/conversations.history'));
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls[0]!.headers.Authorization).toBe('Bearer xoxb-connection-a-fixture');
    expect(historyCalls[1]!.headers.Authorization).toBe('Bearer xoxb-connection-b-fixture');
    expect(calls.filter((call) => call.url === 'https://slack.com/api/auth.test')).toHaveLength(2);

    // Notion and GitHub publish alongside without collision, and route
    // through the same managed seam — a managed call names no backend.
    const agentNotion = agents.create({ name: 'notion-reader' });
    policies.assign(agentNotion.id, policies.create({ name: 'n-page', rules: [allow(`${notion.id}__get_page`)] }).id);
    const routedNotion = await router.call(`${notion.id}__get_page`, { page_id: PAGE_ID }, { agent: agentNotion });
    expect(routedNotion.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: notion.id });

    const agentGithub = agents.create({ name: 'gh-reader' });
    policies.assign(agentGithub.id, policies.create({ name: 'gh', rules: [allow(`${github.id}__get_repository`)] }).id);
    const routedGithub = await router.call(
      `${github.id}__get_repository`,
      { owner: 'octocat', repo: 'hello-world' },
      { agent: agentGithub },
    );
    expect(routedGithub.tool).toMatchObject({ sourceType: 'managed_integration', sourceId: github.id });

    // The activity rows name the connection, not a backend, and only the
    // four authorized calls were ever dispatched.
    const rows = store.activity.list(50).filter((event) => event.type === 'tools.call');
    expect(rows).toHaveLength(4);
    const rowOne = rows.find((row) => row.toolName === `${first.id}__get_conversation_history`);
    expect(rowOne).toMatchObject({ connectionId: first.id, outcome: 'success', requestId: 'req-a' });
    expect(rowOne?.backendId).toBeUndefined();
    expect(rows.find((row) => row.toolName === `${github.id}__get_repository`)).toMatchObject({
      connectionId: github.id,
      outcome: 'success',
    });
  });
});
