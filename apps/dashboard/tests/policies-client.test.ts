// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The policy client against a stubbed `fetch`.
 *
 * Claims pinned here:
 *
 *  * rules are a field of the policy, replaced wholesale — there is no rule
 *    endpoint to call and no partial merge to rely on;
 *  * assignment is a sub-resource, `POST` for assign and `DELETE` on the pair for
 *    unassign (the gateway answers `404` for a pair that does not exist);
 *  * the reverse lookup returns agents, not policies;
 *  * a failed read throws the gateway's own envelope.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const {
  assignPolicy,
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  listPolicyAssignments,
  unassignPolicy,
  updatePolicy,
} = await import('@/lib/api/policies');
const { ApiError } = await import('@/lib/api/errors');

const POLICY = '77777777-7777-4777-8777-777777777777';
const AGENT = '22222222-2222-4222-8222-222222222222';
const BACKEND = '11111111-1111-4111-8111-111111111111';

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POLICY,
    name: 'read-only',
    priority: 10,
    rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
    createdAt: '2026-11-19T00:00:00.000Z',
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

const urlOf = (call = 0): URL => new URL(String(fetchSpy.mock.calls[call]![0]));
const initOf = (call = 0): RequestInit => (fetchSpy.mock.calls[call]![1] ?? {}) as RequestInit;

describe('listPolicies', () => {
  it('forwards the gateway filters and returns pagination', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: [policy()], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }),
    );

    const page = await listPolicies({ search: 'read', effect: 'allow', sort: 'priority' });

    expect(page.data[0]).toMatchObject({ name: 'read-only', priority: 10 });
    expect(urlOf().pathname).toBe('/api/v1/policies');
    // `priority` is a sort value, not a filter — it must not be sent as one.
    expect(Object.fromEntries(urlOf().searchParams)).toEqual({ search: 'read', effect: 'allow', sort: 'priority' });
  });

  it('treats an empty registry as a real zero', async () => {
    fetchSpy.mockResolvedValue(json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));

    await expect(listPolicies()).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('surfaces the gateway envelope for a failed read', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'AUTHENTICATION_ERROR', message: 'Sign in to continue.', requestId: 'r1' } }, 401),
    );

    const error = await listPolicies().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'AUTHENTICATION_ERROR' });
  });
});

describe('policy writes', () => {
  it('creates with POST and the documented body, sending the rule array', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy() }, 201));

    await createPolicy({
      name: 'read-only',
      priority: 10,
      rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
    });

    expect(urlOf().pathname).toBe('/api/v1/policies');
    expect(initOf().method).toBe('POST');
    expect(JSON.parse(String(initOf().body))).toEqual({
      name: 'read-only',
      priority: 10,
      rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
    });
  });

  it('patches the policy and replaces the whole rule array', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy({ rules: [] }) }));

    await updatePolicy(POLICY, { rules: [], description: null });

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}`);
    expect(initOf().method).toBe('PATCH');
    expect(JSON.parse(String(initOf().body))).toEqual({ rules: [], description: null });
  });

  it('deletes the policy and returns what was removed', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy() }));

    const removed = await deletePolicy(POLICY);

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}`);
    expect(initOf().method).toBe('DELETE');
    expect(removed.id).toBe(POLICY);
  });

  it('reports a 409 name clash as a conflict, not a retry', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_CONFLICT', message: 'A policy with that name already exists.' } }, 409),
    );

    await expect(createPolicy({ name: 'dup', rules: [] })).rejects.toMatchObject({ status: 409 });
  });

  it('reports a rule naming a missing backend as a validation error', async () => {
    fetchSpy.mockResolvedValue(
      json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Rule 0 names a backend that does not exist.',
          },
        },
        400,
      ),
    );

    await expect(
      createPolicy({ name: 'bad', rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('assignments', () => {
  it('assigns with a body carrying the agent id, under the policy', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy() }));

    await assignPolicy(POLICY, AGENT);

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}/assignments`);
    expect(initOf().method).toBe('POST');
    expect(JSON.parse(String(initOf().body))).toEqual({ agentId: AGENT });
  });

  it('unassigns with DELETE on the pair', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy() }));

    await unassignPolicy(POLICY, AGENT);

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}/assignments/${AGENT}`);
    expect(initOf().method).toBe('DELETE');
    expect(initOf().body).toBeUndefined();
  });

  it('reports an unassign of a pair that does not exist as a 404', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The agent is not assigned to that policy.' } }, 404),
    );

    await expect(unassignPolicy(POLICY, AGENT)).rejects.toMatchObject({ status: 404 });
  });

  it('reads the reverse lookup as agents, not policies', async () => {
    fetchSpy.mockResolvedValue(
      json({ data: [{ id: AGENT, name: 'claude-code-laptop', enabled: true, status: 'active' }] }),
    );

    const agents = await listPolicyAssignments(POLICY);

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}/assignments`);
    expect(urlOf().search).toBe('');
    expect(agents[0]).toMatchObject({ id: AGENT, name: 'claude-code-laptop' });
    expect(agents[0]).not.toHaveProperty('rules');
  });
});

describe('getPolicy', () => {
  it('addresses one policy by id and never by name', async () => {
    fetchSpy.mockResolvedValue(json({ data: policy() }));

    const read = await getPolicy(POLICY);

    expect(urlOf().pathname).toBe(`/api/v1/policies/${POLICY}`);
    expect(read.rules).toHaveLength(1);
  });

  it('propagates a 404 for an absent policy', async () => {
    fetchSpy.mockResolvedValue(
      json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested policy does not exist.' } }, 404),
    );

    await expect(getPolicy(POLICY)).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
  });
});
