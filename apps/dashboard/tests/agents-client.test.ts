// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent/credential client against a stubbed `fetch`.
 *
 * The claims that matter:
 *
 *  * a credential is always addressed under its agent, so an id from another
 *    agent cannot be expressed;
 *  * only `issueCredential`/`rotateCredential` carry a token, and the client
 *    hands it back untouched;
 *  * `rotate` is a `POST` with no invented grace-period parameter;
 *  * a failed read throws the gateway's own envelope rather than a default.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentAccess,
  issueCredential,
  listAgents,
  listCredentials,
  revokeCredential,
  rotateCredential,
  setAgentEnabled,
  updateAgent,
} = await import('@/lib/api/agents');
const { ApiError } = await import('@/lib/api/errors');

const AGENT = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT,
    name: 'claude-code-laptop',
    clientType: 'claude-code',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function credential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREDENTIAL,
    agentId: AGENT,
    name: 'laptop',
    tokenPrefix: 'umg_abc123',
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
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

function urlOf(call = 0): URL {
  return new URL(String(fetchSpy.mock.calls[call]![0]));
}

function initOf(call = 0): RequestInit {
  return (fetchSpy.mock.calls[call]![1] ?? {}) as RequestInit;
}

describe('listAgents', () => {
  it('returns the registry with pagination', async () => {
    fetchSpy.mockResolvedValue(json({ data: [agent()], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }));

    const page = await listAgents({ search: 'laptop', status: 'active', clientType: 'claude-code' });

    expect(page.data[0]).toMatchObject({ name: 'claude-code-laptop', status: 'active' });
    expect(urlOf().pathname).toBe('/api/v1/agents');
    expect(Object.fromEntries(urlOf().searchParams)).toEqual({
      search: 'laptop',
      status: 'active',
      clientType: 'claude-code',
    });
  });

  it('treats an empty registry as a real zero', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));

    await expect(listAgents()).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('surfaces the gateway envelope for a failed read', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Sign in to continue.', requestId: 'r1' } }, 401),
    );

    const error = await listAgents().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'http', status: 401, code: 'AUTHENTICATION_ERROR' });
  });
});

describe('agent writes', () => {
  it('creates with POST /api/v1/agents and the documented body', async () => {
    fetchSpy.mockResolvedValue(json({ data: agent() }, 201));

    await createAgent({ name: 'claude-code-laptop', clientType: 'claude-code', enabled: true });

    expect(urlOf().pathname).toBe('/api/v1/agents');
    expect(initOf().method).toBe('POST');
    expect(JSON.parse(String(initOf().body))).toEqual({
      name: 'claude-code-laptop',
      clientType: 'claude-code',
      enabled: true,
    });
  });

  it('patches the item and never invents a version parameter', async () => {
    fetchSpy.mockResolvedValue(json({ data: agent({ enabled: false, status: 'disabled' }) }));

    await updateAgent(AGENT, { description: null, clientType: null });

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}`);
    expect(urlOf().search).toBe('');
    expect(initOf().method).toBe('PATCH');
    expect(JSON.parse(String(initOf().body))).toEqual({ description: null, clientType: null });
  });

  it('uses the literal enable/disable routes', async () => {
    fetchSpy.mockImplementation(async () => json({ data: agent({ enabled: false, status: 'disabled' }) }));

    await setAgentEnabled(AGENT, false);
    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/disable`);
    expect(initOf().method).toBe('POST');

    await setAgentEnabled(AGENT, true);
    expect(urlOf(1).pathname).toBe(`/api/v1/agents/${AGENT}/enable`);
  });

  it('deletes and returns the reported blast radius', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: { ...agent(), revokedCredentials: 2, removedAssignments: 1 } }),
    );

    const removed = await deleteAgent(AGENT);

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}`);
    expect(initOf().method).toBe('DELETE');
    expect(removed).toMatchObject({ revokedCredentials: 2, removedAssignments: 1 });
  });

  it('reports a 409 duplicate name as an http conflict, not a retry', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_CONFLICT', message: 'An agent with this name already exists.' } }, 409),
    );

    await expect(createAgent({ name: 'dup' })).rejects.toMatchObject({ status: 409, code: 'RESOURCE_CONFLICT' });
  });
});

describe('credentials', () => {
  it('lists metadata under the agent', async () => {
    fetchSpy.mockResolvedValue(json({ data: [credential()] }));

    const list = await listCredentials(AGENT);

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/credentials`);
    expect(list[0]).toMatchObject({ id: CREDENTIAL, status: 'active' });
    expect(list[0]).not.toHaveProperty('token');
  });

  it('issues and hands back the single token from a 201', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: { ...credential(), token: 'umg_secret_value' }, notice: 'Shown once.' }, 201),
    );

    const issued = await issueCredential(AGENT, { name: 'laptop', expiresAt: '2027-01-01T00:00:00.000Z' });

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/credentials`);
    expect(initOf().method).toBe('POST');
    expect(JSON.parse(String(initOf().body))).toEqual({
      name: 'laptop',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(issued.token).toBe('umg_secret_value');
  });

  it('omits absent optional fields rather than sending empty strings', async () => {
    fetchSpy.mockResolvedValue(json({ data: { ...credential(), token: 't' } }, 201));

    await issueCredential(AGENT);

    expect(JSON.parse(String(initOf().body))).toEqual({});
  });

  it('rotates under the credential path and returns the new token', async () => {
    fetchSpy.mockResolvedValue(
      json(
        {
          data: { ...credential(), id: '44444444-4444-4444-8444-444444444444', token: 'umg_new' },
          previousCredentialId: CREDENTIAL,
        },
        200,
      ),
    );

    const rotated = await rotateCredential(AGENT, CREDENTIAL);

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}/rotate`);
    expect(initOf().method).toBe('POST');
    expect(rotated.token).toBe('umg_new');
  });

  it('revokes and returns the updated metadata with no token', async () => {
    fetchSpy.mockResolvedValue(json({ data: credential({ status: 'revoked', revokedAt: '2026-11-19T01:00:00.000Z' }) }));

    const revoked = await revokeCredential(AGENT, CREDENTIAL);

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}/revoke`);
    expect(revoked.status).toBe('revoked');
    expect(revoked).not.toHaveProperty('token');
  });

  it('addresses the credential through its owner, so a foreign id is a 404', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested credential does not exist.' } }, 404),
    );

    await expect(revokeCredential(AGENT, CREDENTIAL)).rejects.toMatchObject({ status: 404 });

    // There is no global credential route to fall back to.
    expect(urlOf().pathname.startsWith(`/api/v1/agents/${AGENT}/credentials/`)).toBe(true);
  });

  it('reports rotating a revoked credential as a 409', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_CONFLICT', message: 'A revoked credential cannot be rotated.' } }, 409),
    );

    await expect(rotateCredential(AGENT, CREDENTIAL)).rejects.toMatchObject({ status: 409 });
  });
});

describe('getAgentAccess', () => {
  it('reads the gateway evaluator verdict verbatim', async () => {
    fetchSpy.mockResolvedValue(
      json({
        data: {
          agentId: AGENT,
          policies: [{ id: '55555555-5555-4555-8555-555555555555', name: 'read-only', priority: 10 }],
          visibleTools: [{ publicName: 'x__read', backendId: '66666666-6666-4666-8666-666666666666', allowed: true, reason: 'allow' }],
        },
      }),
    );

    const access = await getAgentAccess(AGENT);

    expect(urlOf().pathname).toBe(`/api/v1/agents/${AGENT}/access`);
    expect(access.visibleTools[0]).toMatchObject({ allowed: true, reason: 'allow' });
  });
});
