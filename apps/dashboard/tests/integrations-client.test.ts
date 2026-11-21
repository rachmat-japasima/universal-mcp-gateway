// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The integrations API client, against a stubbed `fetch`.
 *
 * The facts worth pinning are the ones a careless client would fabricate:
 * connections are a plain array (no pagination to invent), a failed read
 * throws rather than rendering as "0 connections", and the one tool listing
 * is a read — nothing in this module can carry a token anywhere.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const { getConnection, listConnections, listConnectionTools, listProviders } = await import('@/lib/api/integrations');
const { ApiError } = await import('@/lib/api/errors');

const ID = '11111111-1111-4111-8111-111111111111';

function connection(): Record<string, unknown> {
  return {
    id: ID,
    providerId: 'github',
    providerName: 'GitHub',
    name: 'org-repos',
    status: 'connected',
    credentialId: '22222222-2222-4222-8222-222222222222',
    metadata: {},
    validatedAt: '2026-11-21T00:00:00.000Z',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listConnections', () => {
  it('returns the plain array the gateway documents, pagination-free', async () => {
    fetchSpy.mockResolvedValue(json({ data: [connection()] }));

    const connections = await listConnections();

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ id: ID, providerId: 'github', status: 'connected' });
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/integrations/connections');
  });

  it('treats an empty registry as a real zero, not an error', async () => {
    fetchSpy.mockResolvedValue(json({ data: [] }));

    await expect(listConnections()).resolves.toEqual([]);
  });

  it('throws the gateway error envelope for a failed read', async () => {
    fetchSpy.mockResolvedValue(json({ error: { code: 'DATABASE_ERROR', message: 'Storage is unavailable.', requestId: 'r1' } }, 503));

    const error = await listConnections().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'http', status: 503, code: 'DATABASE_ERROR' });
  });

  it('refuses a body without the data envelope rather than returning nothing', async () => {
    fetchSpy.mockResolvedValue(json({ connections: [] }));

    await expect(listConnections()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('listProviders', () => {
  it('reads the code-registered provider list', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: [
          {
            id: 'github',
            name: 'GitHub',
            description: 'Read-only GitHub access.',
            capabilities: ['discovery', 'execution'],
            metadata: { authMethod: 'fine-grained personal access token' },
            registeredAt: '2026-11-20T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(listProviders()).resolves.toMatchObject([{ id: 'github', name: 'GitHub' }]);
  });
});

describe('item reads', () => {
  it('reads one connection by id', async () => {
    fetchSpy.mockResolvedValue(json({ data: connection() }));

    await expect(getConnection(ID)).resolves.toMatchObject({ id: ID, name: 'org-repos' });
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe(`/api/v1/integrations/connections/${ID}`);
  });

  it('reads the connection tools, whose source type is the integration, not a backend', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: [
          {
            publicName: `${ID}__list_repositories`,
            originalName: 'list_repositories',
            sourceType: 'managed_integration',
            sourceId: ID,
            inputSchema: { type: 'object' },
            availability: 'available',
            discoveredAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(listConnectionTools(ID)).resolves.toMatchObject([
      { publicName: `${ID}__list_repositories`, sourceType: 'managed_integration', sourceId: ID },
    ]);
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe(`/api/v1/integrations/connections/${ID}/tools`);
  });

  it('surfaces a 404 connection as an error, not an empty tool list', async () => {
    // A fresh `Response` per call: a body can only be read once.
    fetchSpy.mockImplementation(async () =>
      json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested resource does not exist.', requestId: 'r2' } }, 404),
    );

    await expect(getConnection(ID)).rejects.toMatchObject({ kind: 'http', status: 404, code: 'RESOURCE_NOT_FOUND' });
    await expect(listConnectionTools(ID)).rejects.toMatchObject({ status: 404 });
  });
});
