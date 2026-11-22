import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import type { ConnectorContext, ConnectorError, ConnectorResult } from '../src/integrations/connector.js';
import type { Connector } from '../src/integrations/connector.js';
import { ProviderRegistry, githubRegistration } from '../src/integrations/registry.js';
import { IntegrationService } from '../src/integrations/service.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';
import { createGitHubClient, type FetchLike } from '../src/integrations/github/client.js';
import { createGitHubConnector } from '../src/integrations/github/connector.js';
import { githubToolDefinitions } from '../src/integrations/github/tools.js';
import { createLogger } from '../src/monitoring/logger.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { ToolCatalog } from '../src/routing/catalog.js';
import { compileInputSchema } from '../src/routing/schema.js';

/**
 * The GitHub provider against fixture HTTP responses (ADR-053). No request
 * leaves the process: every fetch and every sleep is injected, and the
 * negative assertions pin the boundaries — the token never travels outside
 * the Authorization header, and GitHub's own fields never leave the
 * normalizers.
 *
 * The last describe drives the real `IntegrationService` and `ToolCatalog`
 * with the real connector, so the six tools are proven to flow through the
 * production lifecycle, not just through the connector in isolation.
 */

const TOKEN = 'github_pat_fixture-only-never-real';
const CREDENTIAL_ID = randomUUID();
const NOW = '2026-11-22T00:00:00.000Z';

/** A context whose resolver answers only this connection's reference. */
function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    connectionId: randomUUID(),
    credentialId: CREDENTIAL_ID,
    metadata: {},
    resolveCredential: async (credentialId: string): Promise<string> => {
      if (credentialId !== CREDENTIAL_ID) throw new Error('wrong reference');
      return TOKEN;
    },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type RecordedCall = { url: string; headers: Record<string, string>; signal: AbortSignal; redirect: string };

/** Records every request the client made, and answers from the handler. */
function fixtureFetch(
  handler: (call: RecordedCall) => Response,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers, signal: init.signal, redirect: init.redirect };
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

describe('github client', () => {
  it('authenticates against the fixed origin with the pinned headers', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createGitHubClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('/user');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/user');
    expect(calls[0]!.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'universal-mcp-gateway',
    });
  });

  it('drops undefined query parameters and keeps the defined ones', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse([]));
    const client = createGitHubClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('/user/repos', { page: 2, per_page: 50, visibility: undefined });

    expect(calls[0]!.url).toBe('https://api.github.com/user/repos?page=2&per_page=50');
  });

  it('refuses redirects at the fetch level, so no hop can carry the token to another host', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const client = createGitHubClient({ token: TOKEN, signal: new AbortController().signal, fetchImpl: fetch });

    await client.get('/user');

    // The boundary is enforced by the request itself, not by undici's
    // courtesy of stripping Authorization on cross-origin redirects.
    expect(calls[0]!.redirect).toBe('error');
  });

  it('maps every plain failure status to the connector vocabulary without echoing the token', async () => {
    const cases: Array<{ status: number; headers?: Record<string, string>; kind: string }> = [
      { status: 401, kind: 'reauthorization_required' },
      { status: 403, kind: 'invalid_request' },
      { status: 404, kind: 'invalid_request' },
      { status: 422, kind: 'invalid_request' },
      { status: 418, kind: 'invalid_request' },
      { status: 500, kind: 'provider_error' },
      { status: 503, kind: 'provider_error' },
    ];

    for (const { status, headers, kind } of cases) {
      const client = createGitHubClient({
        token: TOKEN,
        signal: new AbortController().signal,
        fetchImpl: () => jsonResponse({ message: 'fixture' }, status, headers),
      });

      const result = await client.get('/user');
      expect(result, `status ${status}`).toMatchObject({ ok: false, error: { kind } });
      expect(JSON.stringify(result), `status ${status}`).not.toContain(TOKEN);
    }
  });

  it('reads a 403 with an exhausted rate budget as rate limiting, not permission', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () =>
        jsonResponse(
          {},
          403,
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000', 'retry-after': '60' },
        ),
    });

    const result = await client.get('/user');
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (result.ok) return;
    expect(result.error.message).toContain('rate limiting');
    // A 60 s wait exceeds the retry ceiling, so the reset time is surfaced
    // instead of the call sleeping through the caller's budget.
    expect(result.error.message).toContain('1800000000');
  });

  it('retries exactly once when Retry-After fits the ceiling, then succeeds', async () => {
    let rateLimited = true;
    const { fetch, calls } = fixtureFetch(() => {
      if (rateLimited) {
        rateLimited = false;
        return jsonResponse({}, 429, { 'retry-after': '1' });
      }
      return jsonResponse({ login: 'octocat' });
    });
    const sleeps: number[] = [];
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('/user');

    expect(result).toMatchObject({ ok: true, value: { login: 'octocat' } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('gives up after the single bounded retry', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '1' }));
    const sleeps: number[] = [];
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get('/user');

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry at all when the wait would exceed the ceiling', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '60' }));
    const sleeps: number[] = [];
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await client.get('/user');

    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('reports a network failure as unreachable', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.get('/user')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unreachable' },
    });
  });

  it('refuses a 200 whose body is not valid JSON', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () => new Response('<html>not json</html>', { status: 200 }),
    });

    await expect(client.get('/user')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'provider_error' },
    });
  });

  it('treats an empty 200 body as an empty object', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      signal: new AbortController().signal,
      fetchImpl: () => new Response('', { status: 200 }),
    });

    await expect(client.get('/user')).resolves.toEqual({ ok: true, value: {} });
  });
});

describe('github tools', () => {
  it('advertise schemas the production validator compiles, and reject what the connector refuses', () => {
    const schemaOf = (name: string): ReturnType<typeof compileInputSchema> =>
      compileInputSchema(githubToolDefinitions().find((tool) => tool.name === name)!.inputSchema);

    for (const tool of githubToolDefinitions()) {
      // Every advertised schema must be compilable: a tool the router would
      // forward unvalidated is a tool whose contract nobody checked.
      expect(compileInputSchema(tool.inputSchema).validate, tool.name).toBeDefined();
    }

    // Only `list_repositories` takes no arguments; every other tool has
    // required identity fields the router rejects before the connector runs.
    expect(schemaOf('list_repositories').validate!({}).valid).toBe(true);
    for (const name of ['get_repository', 'list_issues', 'get_issue', 'list_pull_requests', 'get_pull_request']) {
      expect(schemaOf(name).validate!({}).valid, name).toBe(false);
    }

    // Pagination bounds.
    expect(schemaOf('list_repositories').validate!({ per_page: 101 }).valid).toBe(false);
    expect(schemaOf('list_repositories').validate!({ page: 0 }).valid).toBe(false);
    expect(schemaOf('list_repositories').validate!({ per_page: 100, page: 10_000 }).valid).toBe(true);
    // Owner/repo pattern, unknown keys, and enum values are enforced.
    expect(schemaOf('get_repository').validate!({ owner: 'has space', repo: 'x' }).valid).toBe(false);
    expect(schemaOf('get_repository').validate!({ owner: 'octocat', repo: 'hello-world', extra: true }).valid).toBe(false);
    expect(schemaOf('list_issues').validate!({ owner: 'octocat', repo: 'x', state: 'reopened' }).valid).toBe(false);
    expect(schemaOf('list_issues').validate!({ owner: 'octocat', repo: 'x', state: 'all', labels: 'bug,ui' }).valid).toBe(true);
    // Numbers are integers and positive.
    expect(schemaOf('get_issue').validate!({ owner: 'o', repo: 'r', issue_number: 0 }).valid).toBe(false);
    expect(schemaOf('get_issue').validate!({ owner: 'o', repo: 'r', issue_number: 1.5 }).valid).toBe(false);
  });
});

describe('github connector: discovery', () => {
  it('proves the token once, then lists exactly six read-only tools', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ login: 'octocat' }));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const tools = value(await connector.discoverTools!(context()));

    expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/user']);
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_repositories',
      'get_repository',
      'list_issues',
      'get_issue',
      'list_pull_requests',
      'get_pull_request',
    ]);
    for (const tool of tools) expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it('refuses to discover without a stored credential and never fetches', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = await connector.discoverTools!(context({ credentialId: null }));

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it('propagates a rejected token as reauthorization_required', async () => {
    const connector = createGitHubConnector({ fetchImpl: () => jsonResponse({}, 401) });

    await expect(connector.discoverTools!(context())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'reauthorization_required' },
    });
  });

  it('resolves the token through the scoped resolver and exposes it only in the header', async () => {
    const resolutions: string[] = [];
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ login: 'octocat' }));
    const connector: Connector = createGitHubConnector({ fetchImpl: fetch });

    await connector.discoverTools!(
      context({
        resolveCredential: async (credentialId: string) => {
          resolutions.push(credentialId);
          return TOKEN;
        },
      }),
    );

    expect(resolutions).toEqual([CREDENTIAL_ID]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('github connector: execution', () => {
  const REPO = {
    id: 1296269,
    name: 'Hello-World',
    full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' },
    visibility: 'public',
    default_branch: 'master',
    description: 'This your first repo!',
    html_url: 'https://github.com/octocat/Hello-World',
    updated_at: '2011-01-26T19:01:12Z',
    // Untrusted surplus: normalization must drop it, not forward it.
    node_id: 'R_kgDOAhZwzA',
    private: false,
  };

  const ISSUE = {
    number: 1,
    title: 'Found a bug',
    state: 'open',
    user: { login: 'octocat' },
    labels: [{ name: 'bug' }, { name: 'help wanted' }],
    html_url: 'https://github.com/octocat/Hello-World/issues/1',
    created_at: '2011-01-26T19:01:12Z',
    updated_at: '2011-01-27T19:01:12Z',
    body: "I'm having a problem with this.",
    node_id: 'MDU6SXNzdWUx',
  };

  const PULL_REQUEST = {
    number: 1347,
    title: 'new-feature',
    state: 'open',
    user: { login: 'octocat' },
    head: { ref: 'new-topic' },
    base: { ref: 'master' },
    draft: false,
    html_url: 'https://github.com/octocat/Hello-World/pull/1347',
    created_at: '2011-01-26T19:01:12Z',
    updated_at: '2011-01-27T19:01:12Z',
    body: 'Please pull these changes in.',
    mergeable: null,
    node_id: 'MDExOlB1bGxSZXF1ZXN0MTM0N3',
  };

  it('executes list_repositories with the documented pagination defaults', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse([REPO]));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'list_repositories', {}));

    expect(calls[0]!.url).toBe('https://api.github.com/user/repos?page=1&per_page=20');
    expect(result.structuredContent).toEqual({
      items: [
        {
          id: 1296269,
          name: 'Hello-World',
          fullName: 'octocat/Hello-World',
          ownerLogin: 'octocat',
          visibility: 'public',
          defaultBranch: 'master',
          description: 'This your first repo!',
          htmlUrl: 'https://github.com/octocat/Hello-World',
          updatedAt: '2011-01-26T19:01:12Z',
        },
      ],
    });
    // The text form carries the same closed payload — nothing raw, nothing extra.
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual(
      result.structuredContent,
    );
    expect(JSON.stringify(result)).not.toContain('node_id');
  });

  it('keeps explicit pagination and pass-through filters the caller asked for', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse([]));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    await connector.executeTool!(
      context(),
      'list_repositories',
      { per_page: 5, page: 3, visibility: 'private', sort: 'created', direction: 'asc' },
    );

    expect(calls[0]!.url).toBe(
      'https://api.github.com/user/repos?page=3&per_page=5&visibility=private&sort=created&direction=asc',
    );
  });

  it('executes get_repository and returns only the closed summary shape', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse(REPO));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(await connector.executeTool!(context(), 'get_repository', { owner: 'octocat', repo: 'hello-world' }));

    expect(calls[0]!.url).toBe('https://api.github.com/repos/octocat/hello-world');
    expect(result.structuredContent).toEqual({
      id: 1296269,
      name: 'Hello-World',
      fullName: 'octocat/Hello-World',
      ownerLogin: 'octocat',
      visibility: 'public',
      defaultBranch: 'master',
      description: 'This your first repo!',
      htmlUrl: 'https://github.com/octocat/Hello-World',
      updatedAt: '2011-01-26T19:01:12Z',
    });
  });

  it('excludes pull requests from list_issues, because they are not issues', async () => {
    const prMixingIn = { ...ISSUE, number: 2, pull_request: { url: 'x' } };
    const { fetch } = fixtureFetch(() => jsonResponse([ISSUE, prMixingIn]));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'list_issues', { owner: 'octocat', repo: 'Hello-World' }),
    );

    const items = (result.structuredContent as { items: Array<{ number: number }> }).items;
    expect(items.map((issue) => issue.number)).toEqual([1]);
  });

  it('executes get_issue including the body, with labels flattened', async () => {
    const { fetch } = fixtureFetch(() => jsonResponse(ISSUE));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'get_issue', { owner: 'octocat', repo: 'Hello-World', issue_number: 1 }),
    );

    expect(result.structuredContent).toMatchObject({
      number: 1,
      authorLogin: 'octocat',
      labels: ['bug', 'help wanted'],
      body: "I'm having a problem with this.",
    });
    expect(JSON.stringify(result)).not.toContain('node_id');
  });

  it('executes list_pull_requests with branch names, not raw ref objects', async () => {
    const { fetch } = fixtureFetch(() => jsonResponse([PULL_REQUEST]));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(context(), 'list_pull_requests', { owner: 'octocat', repo: 'Hello-World', state: 'closed' }),
    );

    expect(result.structuredContent).toEqual({
      items: [
        {
          number: 1347,
          title: 'new-feature',
          state: 'open',
          authorLogin: 'octocat',
          headBranch: 'new-topic',
          baseBranch: 'master',
          draft: false,
          htmlUrl: 'https://github.com/octocat/Hello-World/pull/1347',
          createdAt: '2011-01-26T19:01:12Z',
          updatedAt: '2011-01-27T19:01:12Z',
        },
      ],
    });
  });

  it('executes get_pull_request with the body and the honest null mergeable state', async () => {
    const { fetch } = fixtureFetch(() => jsonResponse(PULL_REQUEST));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    const result = value(
      await connector.executeTool!(
        context(),
        'get_pull_request',
        { owner: 'octocat', repo: 'Hello-World', pull_number: 1347 },
      ),
    );

    expect(result.structuredContent).toMatchObject({ body: 'Please pull these changes in.', mergeable: null });
  });

  it('refuses a detail response whose shape was not recognized', async () => {
    const connector = createGitHubConnector({ fetchImpl: () => jsonResponse({ unhelpful: true }) });

    const result = await connector.executeTool!(context(), 'get_repository', { owner: 'octocat', repo: 'hello-world' });

    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (!result.ok) expect(result.error.message).toContain('shape was not recognized');
  });

  it('defends against malformed arguments even though the router already validates', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({}));
    const connector = createGitHubConnector({ fetchImpl: fetch });

    // Missing required fields on three different tools, and a non-object.
    for (const [tool, args] of [
      ['get_repository', { owner: 'octocat' }],
      ['get_issue', { owner: 'octocat', repo: 'Hello-World' }],
      ['get_pull_request', { repo: 'Hello-World', pull_number: 1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await connector.executeTool!(context(), tool, args);
      expect(result, tool).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    }

    await expect(connector.executeTool!(context(), 'list_repositories', 'nope')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses a tool name the provider never registered', async () => {
    const connector = createGitHubConnector({ fetchImpl: () => jsonResponse({}) });

    await expect(connector.executeTool!(context(), 'create_issue', {})).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request', message: 'Unknown GitHub tool "create_issue".' },
    });
  });

  it('surfaces a provider refusal from execution untouched', async () => {
    const connector = createGitHubConnector({ fetchImpl: () => jsonResponse({}, 404) });

    const result = await connector.executeTool!(context(), 'list_issues', { owner: 'octocat', repo: 'missing' });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    if (!result.ok) expect(result.error.message).toContain('404');
  });
});

describe('github through the production service', () => {
  let directory: string;
  let store: Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'github-service-'));
    store = openStore({ path: join(directory, 'gateway.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The real registration, the real connector, the real `IntegrationService`
   * and `ToolCatalog` — only the HTTP seam is a fixture, which is the mock-only
   * ceiling this phase works under. The router seam itself is pinned by
   * `integrations-execution.test.ts` with a fixture connector; wiring GitHub
   * into the router would require a live handshake, so this is as far as the
   * proof goes without a network.
   */
  function service(fetch: FetchLike): { integrations: IntegrationService; catalog: ToolCatalog } {
    const registry = new ProviderRegistry();
    registry.register(githubRegistration, createGitHubConnector({ fetchImpl: fetch }));
    const catalog = new ToolCatalog();

    const integrations = new IntegrationService({
      store,
      registry,
      vault: new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(32).toString('base64') })),
      catalog,
      logger: createLogger(loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' })),
      now: () => NOW,
    });
    return { integrations, catalog };
  }

  it('connects through the real handshake and publishes the six tools under the connection namespace', async () => {
    const { fetch, calls } = fixtureFetch(() => jsonResponse({ login: 'octocat' }));
    const { integrations, catalog } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'github', name: 'fixture-github', metadata: {} });
    integrations.storeCredential(connection.id, TOKEN);

    const { connection: connected, outcome } = await integrations.connect(connection.id);

    // One handshake call, no more.
    expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/user']);
    expect(connected.status).toBe('connected');
    // The handshake is the token's proof: the service stamps it.
    expect(connected.validatedAt).toBe(NOW);

    // The snapshot diff speaks the provider's own names.
    expect(outcome.added).toEqual([
      'get_issue',
      'get_pull_request',
      'get_repository',
      'list_issues',
      'list_pull_requests',
      'list_repositories',
    ]);
    // ADR-048 namespacing: what a client calls is `<connection_id>__<tool>`,
    // so a stored name never changes meaning, whoever else connects later.
    expect(catalog.listByConnection(connection.id).map((tool) => tool.publicName)).toEqual([
      `${connection.id}__get_issue`,
      `${connection.id}__get_pull_request`,
      `${connection.id}__get_repository`,
      `${connection.id}__list_issues`,
      `${connection.id}__list_pull_requests`,
      `${connection.id}__list_repositories`,
    ]);
    expect(catalog.listByConnection(connection.id).every((tool) => tool.availability === 'available')).toBe(true);
  });

  it('lands a rejected token in `reauthorization_required`, tools unpublished', async () => {
    const { integrations, catalog } = service(() => jsonResponse({ message: 'Bad credentials' }, 401));

    const connection = integrations.create({ id: randomUUID(), providerId: 'github', name: 'fixture-github', metadata: {} });
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
      return jsonResponse({ login: 'octocat' });
    });
    const { integrations } = service(fetch);

    const connection = integrations.create({ id: randomUUID(), providerId: 'github', name: 'fixture-github', metadata: {} });
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
