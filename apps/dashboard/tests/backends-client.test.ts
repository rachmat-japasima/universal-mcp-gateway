// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The backend API client, against a stubbed `fetch`.
 *
 * This is the layer that decides what a page actually receives, so the cases
 * that matter are the ones where a careless client would fabricate a result:
 *
 *  * an empty registry is `{data: [], pagination}` — never a thrown error;
 *  * a failed read throws `ApiError`, so the page can render "unavailable"
 *    instead of "0 backends";
 *  * an unauthorised write is refused **before** the request, so an expired
 *    session does not masquerade as a permission problem;
 *  * `expectedVersion` travels in the query string, because that is where the
 *    gateway reads it — a body field would be silently ignored and the write
 *    would be a blind overwrite;
 *  * a body without the documented envelope is an `invalid-response`, not data.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const {
  BACKEND_TRANSPORTS,
  connectBackend,
  createBackend,
  deleteBackend,
  getAllBackendRuntime,
  getBackend,
  getBackendRuntime,
  listBackends,
  reconnectBackend,
  setBackendEnabled,
  updateBackend,
  validateBackend,
} = await import('@/lib/api/backends');
const { ApiError } = await import('@/lib/api/errors');

const ID = '11111111-1111-4111-8111-111111111111';

function backend(): Record<string, unknown> {
  return {
    id: ID,
    name: 'filesystem',
    transport: 'stdio',
    connection: { type: 'stdio', command: 'npx', args: [], env: {} },
    enabled: true,
    timeoutMs: 30000,
    concurrencyMode: 'serialized',
    version: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
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

describe('listBackends', () => {
  it('returns data and pagination from the documented envelope', async () => {
    fetchSpy.mockResolvedValue(json({ data: [backend()], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }));

    const page = await listBackends();

    expect(page.data).toHaveLength(1);
    expect(page.pagination.total).toBe(1);
  });

  it('treats an empty registry as a real zero, not an error', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));

    await expect(listBackends()).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('serialises only the supported query parameters', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 2, limit: 20, total: 0, totalPages: 0 } }));

    await listBackends({ search: 'file', transport: 'stdio', enabled: false, page: 2, sort: 'createdAt', order: 'desc' });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/backends');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'file',
      transport: 'stdio',
      enabled: 'false',
      page: '2',
      sort: 'createdAt',
      order: 'desc',
    });
  });

  it('refuses a body without pagination rather than defaulting one', async () => {
    fetchSpy.mockResolvedValue(json({ data: [] }));

    await expect(listBackends()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('refuses a data field that is not a list', async () => {
    fetchSpy.mockResolvedValue(json({ data: { id: ID }, pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }));

    await expect(listBackends()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('throws the gateway error envelope for a failed read', async () => {
    fetchSpy.mockResolvedValue(json({ error: { code: 'DATABASE_ERROR', message: 'Storage is unavailable.', requestId: 'r1' } }, 503));

    const error = await listBackends().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'http', status: 503, code: 'DATABASE_ERROR', requestId: 'r1' });
    expect((error as InstanceType<typeof ApiError>).userMessage).toBe('Storage is unavailable.');
  });
});

describe('reads', () => {
  it('reads one backend by id', async () => {
    fetchSpy.mockResolvedValue(json({ data: backend() }));

    await expect(getBackend(ID)).resolves.toMatchObject({ id: ID, name: 'filesystem' });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(`/api/v1/backends/${ID}`);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ headers: { Cookie: 'umg_operator=token' } });
  });

  it('reads the full runtime view, including reconnectAttempts', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: {
          backendId: ID,
          status: 'connected',
          lastConnectedAt: '2026-11-19T01:00:00.000Z',
          lastHealthCheckAt: '2026-11-19T01:05:00.000Z',
          reconnectAttempts: 2,
          updatedAt: '2026-11-19T01:05:00.000Z',
        },
      }),
    );

    await expect(getBackendRuntime(ID)).resolves.toMatchObject({ reconnectAttempts: 2, status: 'connected' });
  });

  it('reads every runtime state', async () => {
    fetchSpy.mockResolvedValue(json({ data: [{ backendId: ID, status: 'disconnected', reconnectAttempts: 0 }] }));

    await expect(getAllBackendRuntime()).resolves.toHaveLength(1);
  });

  it('rejects a 401 read with the sign-in message the gateway sent', async () => {
    fetchSpy.mockResolvedValue(json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Sign in to continue.' } }, 401));

    const error = await getBackend(ID).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'http', status: 401, code: 'AUTHENTICATION_ERROR' });
    expect((error as InstanceType<typeof ApiError>).userMessage).toBe('Sign in to continue.');
  });

  it('reports an unreachable gateway as unavailable, not as an empty result', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const error = await getBackend(ID).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'unavailable' });
    expect((error as InstanceType<typeof ApiError>).userMessage).toContain('Cannot reach the gateway');
  });

  it('reports a timeout as a timeout', async () => {
    fetchSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(getBackend(ID)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('writes', () => {
  it('creates with POST and the CSRF token, and never sends expectedVersion', async () => {
    fetchSpy.mockResolvedValue(json({ data: backend() }, 201));

    const input = {
      name: 'filesystem',
      connection: { type: 'stdio' as const, command: 'npx', args: ['-y', 'server'], env: {} },
    };
    await createBackend(input);

    const [url, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/backends');
    expect(url.search).toBe('');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-token', Cookie: 'umg_operator=token' });
  });

  it('updates with PATCH and sends expectedVersion as a query parameter', async () => {
    fetchSpy.mockResolvedValue(json({ data: backend() }));

    await updateBackend(ID, { name: 'renamed', description: null, concurrencyLimit: null }, 7);

    const [url, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit];
    expect(url.pathname).toBe(`/api/v1/backends/${ID}`);
    expect(url.searchParams.get('expectedVersion')).toBe('7');
    expect(init.method).toBe('PATCH');
    // `null` is a request to clear, and must survive serialisation as `null`.
    expect(JSON.parse(String(init.body))).toEqual({ name: 'renamed', description: null, concurrencyLimit: null });
  });

  it('enables and disables with the version, never in the body', async () => {
    // A fresh `Response` per call: a body can only be read once.
    fetchSpy.mockImplementation(async () => json({ data: backend() }));

    await setBackendEnabled(ID, true, 3);
    await setBackendEnabled(ID, false, 4);

    const [enable, disable] = fetchSpy.mock.calls as Array<[URL, RequestInit]>;
    expect(enable![0].pathname).toBe(`/api/v1/backends/${ID}/enable`);
    expect(enable![0].searchParams.get('expectedVersion')).toBe('3');
    expect(enable![1].body).toBeUndefined();
    expect(disable![0].pathname).toBe(`/api/v1/backends/${ID}/disable`);
    expect(disable![0].searchParams.get('expectedVersion')).toBe('4');
  });

  it('posts the three connection actions without a body', async () => {
    fetchSpy.mockImplementation(async () => json({ data: { backendId: ID, status: 'connected', reconnectAttempts: 0 } }));

    await connectBackend(ID);
    await reconnectBackend(ID);
    await deleteBackend(ID);

    const calls = fetchSpy.mock.calls as Array<[URL, RequestInit]>;
    expect(calls[0]![0].pathname).toBe(`/api/v1/backends/${ID}/connect`);
    expect(calls[1]![0].pathname).toBe(`/api/v1/backends/${ID}/reconnect`);
    expect(calls[2]![0].pathname).toBe(`/api/v1/backends/${ID}`);
    expect(calls[2]![1].method).toBe('DELETE');
    for (const [, init] of calls) expect(init.body).toBeUndefined();
  });

  it('treats a 409 as an error, not as a successful no-op', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_CONFLICT', message: 'The backend is disabled; enable it before connecting.' } }, 409),
    );

    const error = await connectBackend(ID).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'http', status: 409, code: 'RESOURCE_CONFLICT' });
  });

  it('refuses a write with no session before sending it', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/guard', () => ({
      operatorCookieHeader: async () => undefined,
      operatorCredentials: async () => ({}),
    }));

    const client = await import('@/lib/api/client');

    await expect(client.request('/api/v1/backends', {}, { method: 'POST', body: {} })).rejects.toMatchObject({
      kind: 'http',
      status: 401,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('validateBackend', () => {
  it('returns an invalid verdict as data, because it is a successful answer', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: { valid: false, transport: 'stdio', errors: [{ path: 'connection.command', message: 'required' }] },
      }),
    );

    const result = await validateBackend({ name: 'x' });

    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.path).toBe('connection.command');
  });

  it('returns a valid verdict with the normalised configuration', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: { valid: true, transport: 'stdio', normalized: { name: 'x', timeoutMs: 30000 } } }),
    );

    await expect(validateBackend({ name: 'x' })).resolves.toMatchObject({
      valid: true,
      normalized: { timeoutMs: 30000 },
    });
  });

  it('throws when validation itself could not run', async () => {
    fetchSpy.mockResolvedValue(json({ error: { code: 'BACKEND_TIMEOUT', message: 'The gateway did not answer in time.' } }, 504));

    await expect(validateBackend({ name: 'x' })).rejects.toMatchObject({ status: 504, code: 'BACKEND_TIMEOUT' });
  });
});

describe('BACKEND_TRANSPORTS', () => {
  it('names exactly the transports the gateway accepts', () => {
    expect([...BACKEND_TRANSPORTS]).toEqual(['stdio', 'streamable-http']);
  });
});
