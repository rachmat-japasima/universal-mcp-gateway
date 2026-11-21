import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { Agent, AgentCredential, Session } from '@/lib/api/types';

/**
 * One session's detail.
 *
 * Claims pinned here:
 *
 *  * a credential *id* is shown, but never a token, a hash or a digest;
 *  * the protocol session id is labelled as a routing handle, not a secret;
 *  * a failed agent or credential read degrades only its own value — the binding
 *    and the terminate control survive;
 *  * a credential that has since been revoked is explained rather than silently
 *    omitted.
 */

const getAgent = vi.fn();
const listCredentials = vi.fn();

vi.mock('@/lib/api/agents', () => ({
  getAgent: (...args: unknown[]) => getAgent(...args),
  listCredentials: (...args: unknown[]) => listCredentials(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { SessionDetail } = await import('@/features/sessions/session-detail');

const SESSION = '99999999-9999-4999-8999-999999999999';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    mcpSessionId: 'proto-123',
    agentId: AGENT,
    credentialId: CREDENTIAL,
    status: 'active',
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActivityAt: '2026-11-20T10:05:00.000Z',
    expiresAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
}

function credential(overrides: Partial<AgentCredential> = {}): AgentCredential {
  return {
    id: CREDENTIAL,
    agentId: AGENT,
    name: 'laptop',
    tokenPrefix: 'umg_abc',
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  getAgent.mockReset();
  listCredentials.mockReset();
  getAgent.mockResolvedValue({
    id: AGENT,
    name: 'claude-code-laptop',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  } satisfies Agent);
  listCredentials.mockResolvedValue([credential()]);
});

describe('SessionDetail', () => {
  it('shows the binding, the credential metadata, and no secret', async () => {
    const { container } = render(await SessionDetail({ session: session() }));

    expect(screen.getByText('claude-code-laptop')).toBeTruthy();
    expect(screen.getByText(CREDENTIAL)).toBeTruthy();
    expect(screen.getByText('umg_abc')).toBeTruthy();
    expect(screen.getByText(/routing handle/)).toBeTruthy();

    // The payload has no token field at all; the page must not print one.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/umg_[0-9a-f]{8,}/);
    expect(text).not.toMatch(/hash/i);
  });

  it('degrades the agent name to the id when that read fails', async () => {
    getAgent.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    render(await SessionDetail({ session: session() }));

    expect(screen.getAllByText(AGENT).length).toBeGreaterThan(0);
    // The terminate control is still offered.
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeTruthy();
  });

  it('explains a credential that is no longer listed', async () => {
    listCredentials.mockResolvedValue([]);

    render(await SessionDetail({ session: session() }));

    expect(screen.getByText(/no longer in the agent/)).toBeTruthy();
  });

  it('shows the termination reason for a finished session', async () => {
    render(
      await SessionDetail({
        session: session({ status: 'terminated', terminatedAt: '2026-11-20T11:00:00.000Z', terminationReason: 'idle_timeout' }),
      }),
    );

    expect(screen.getByText('Reason: idle_timeout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminate' }).getAttribute('aria-disabled')).toBe('true');
  });
});
