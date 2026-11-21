// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session client against a stubbed `fetch`.
 *
 * Claims pinned here:
 *
 *  * the list forwards only the filters the gateway defines — there is no
 *    `search` parameter, and inventing one would make the box lie;
 *  * a detail read addresses the internal id, never the protocol session id;
 *  * terminate is a `POST` with no body (the gateway defaults the reason to
 *    `operator_terminated`, which is exactly what this action is);
 *  * a failed read throws the gateway's own envelope.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const { getSession, listSessions, terminateSession } = await import('@/lib/api/sessions');
const { ApiError } = await import('@/lib/api/errors');

const SESSION = '99999999-9999-4999-8999-999999999999';
const AGENT = '22222222-2222-4222-8222-222222222222';

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION,
    mcpSessionId: 'proto-123',
    agentId: AGENT,
    credentialId: '33333333-3333-4333-8333-333333333333',
    status: 'active',
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActivityAt: '2026-11-20T10:05:00.000Z',
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

describe('listSessions', () => {
  it('returns the page with pagination metadata', async () => {
    fetchSpy.mockImplementation(async () =>
      json({ data: [session()], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }),
    );

    const page = await listSessions();

    expect(page.data[0]).toMatchObject({ id: SESSION, status: 'active', agentId: AGENT });
    expect(page.pagination.total).toBe(1);
  });

  it('forwards only the filters the gateway accepts', async () => {
    fetchSpy.mockImplementation(async () => json({ data: [], pagination: { page: 2, limit: 20, total: 21, totalPages: 2 } }));

    await listSessions({ status: 'expired', agentId: AGENT, sort: 'lastActivityAt', order: 'asc', page: 2 });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/sessions');
    expect(url.searchParams.get('status')).toBe('expired');
    expect(url.searchParams.get('agentId')).toBe(AGENT);
    expect(url.searchParams.get('sort')).toBe('lastActivityAt');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('page')).toBe('2');
    // No search parameter exists in the contract.
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('refuses a response without pagination rather than inventing a total', async () => {
    fetchSpy.mockImplementation(async () => json({ data: [session()] }));

    await expect(listSessions()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('getSession', () => {
  it('addresses the internal session id', async () => {
    fetchSpy.mockImplementation(async () => json({ data: session() }));

    const read = await getSession(SESSION);

    expect(read.id).toBe(SESSION);
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe(`/api/v1/sessions/${SESSION}`);
  });

  it('surfaces a 404 as the gateway envelope', async () => {
    fetchSpy.mockImplementation(async () =>
      json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested session does not exist.', requestId: 'r1' } }, 404),
    );

    const error = await getSession(SESSION).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(404);
    expect((error as InstanceType<typeof ApiError>).code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('terminateSession', () => {
  it('posts with no body, so the gateway applies operator_terminated', async () => {
    fetchSpy.mockImplementation(async () => json({ data: session({ status: 'terminated', terminatedAt: '2026-11-20T10:06:00.000Z', terminationReason: 'operator_terminated' }) }));

    const ended = await terminateSession(SESSION);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/sessions/${SESSION}/terminate`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(ended.status).toBe('terminated');
  });

  it('sends an explicit reason when one is given', async () => {
    fetchSpy.mockImplementation(async () => json({ data: session({ status: 'terminated' }) }));

    await terminateSession(SESSION, 'transport_lost');

    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'transport_lost' });
  });

  it('reports a rejected termination instead of claiming success', async () => {
    fetchSpy.mockImplementation(async () =>
      json({ error: { code: 'VALIDATION_ERROR', message: 'reason: Invalid option', requestId: 'r2' } }, 400),
    );

    const error = await terminateSession(SESSION).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(400);
  });
});
