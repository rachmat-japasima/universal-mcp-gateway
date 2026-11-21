// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tool catalog client, against a stubbed `fetch`.
 *
 * The cases that matter are the ones where a careless client would fabricate a
 * result: an empty catalog is a real zero, a failed read throws, a detail read
 * addresses the *public name* (not an id), and a list without pagination is a
 * protocol failure rather than an assumed single page.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const { getDiscoveryReports, getTool, getToolConflicts, listTools } = await import('@/lib/api/tools');
const { ApiError } = await import('@/lib/api/errors');

const BACKEND = '11111111-1111-4111-8111-111111111111';
const NAME = '11111111-1111-4111-8111-111111111111__read_file';

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicName: NAME,
    originalName: 'read_file',
    backendId: BACKEND,
    description: 'Read one file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    availability: 'available',
    discoveredAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
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

describe('listTools', () => {
  it('returns the catalog with pagination', async () => {
    fetchSpy.mockResolvedValue(json({ data: [tool()], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }));

    const page = await listTools();

    expect(page.data[0]).toMatchObject({ publicName: NAME, availability: 'available' });
    expect(page.pagination.total).toBe(1);
  });

  it('treats an empty catalog as a real zero', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));

    await expect(listTools()).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('serialises only the parameters the gateway accepts', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 2, limit: 20, total: 0, totalPages: 0 } }));

    await listTools({ search: 'read', backendId: BACKEND, availability: 'conflict', page: 2, sort: 'discoveredAt' });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/tools');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'read',
      backendId: BACKEND,
      availability: 'conflict',
      page: '2',
      sort: 'discoveredAt',
    });
  });

  it('refuses a list body without pagination', async () => {
    fetchSpy.mockResolvedValue(json({ data: [] }));

    await expect(listTools()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('surfaces the gateway envelope for a failed read', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Sign in to continue.', requestId: 'r1' } }, 401),
    );

    const error = await listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'http', status: 401, code: 'AUTHENTICATION_ERROR' });
    expect((error as InstanceType<typeof ApiError>).userMessage).toBe('Sign in to continue.');
  });
});

describe('getTool', () => {
  it('addresses the tool by public name, encoded into the path', async () => {
    fetchSpy.mockResolvedValue(json({ data: tool() }));

    await getTool('weird name/with%slash');

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/tools/weird%20name%2Fwith%25slash');
  });

  it('returns schemas verbatim, unparsed', async () => {
    const inputSchema = { type: 'object', properties: { a: { type: 'string', xDomain: '<script>' } } };
    fetchSpy.mockResolvedValue(json({ data: tool({ inputSchema }) }));

    const found = await getTool(NAME);

    expect(found.inputSchema).toEqual(inputSchema);
  });

  it('reports a 404 as a not-found http error, not as invalid data', async () => {
    fetchSpy.mockResolvedValue(json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested tool does not exist.' } }, 404));

    await expect(getTool('missing')).rejects.toMatchObject({ kind: 'http', status: 404, code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('catalog reports', () => {
  it('reads discovery reports', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: [
          {
            backendId: BACKEND,
            status: 'ok',
            toolCount: 3,
            conflictCount: 0,
            rejectedCount: 1,
            discoveredAt: '2026-11-19T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(getDiscoveryReports()).resolves.toMatchObject([{ status: 'ok', toolCount: 3 }]);
  });

  it('reads conflicts with every claimant', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: [{ publicName: 'x__dup', claimants: [{ backendId: BACKEND, originalName: 'dup' }] }] }),
    );

    const conflicts = await getToolConflicts();
    expect(conflicts[0]!.claimants).toHaveLength(1);
  });
});
