import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentAccess, AgentCredential } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * Agent detail.
 *
 * Four claims:
 *
 *  * credentials render as metadata, and no token path exists from this page;
 *  * effective access is the gateway's verdict rendered as data — including its
 *    `reason` string — never a browser-side evaluation;
 *  * an access failure degrades to a notice while the revoke controls stay usable;
 *  * a zero-policy agent is described as the default-deny baseline, not as a
 *    missing screen.
 */

const listCredentials = vi.fn();
const getAgentAccess = vi.fn();

vi.mock('@/lib/api/agents', () => ({
  listCredentials: (...args: unknown[]) => listCredentials(...args),
  getAgentAccess: (...args: unknown[]) => getAgentAccess(...args),
}));
vi.mock('@/lib/api/write-client', () => ({ send: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { AgentDetail } = await import('@/features/agents/agent-detail');

const AGENT = '22222222-2222-4222-8222-222222222222';
const BACKEND = '11111111-1111-4111-8111-111111111111';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: 'claude-code-laptop',
    description: 'Operator workstation',
    clientType: 'claude-code',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

const credential: AgentCredential = {
  id: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT,
  name: 'laptop',
  tokenPrefix: 'umg_abc123',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
};

function access(overrides: Partial<AgentAccess> = {}): AgentAccess {
  return {
    agentId: AGENT,
    policies: [{ id: '55555555-5555-4555-8555-555555555555', name: 'read-only', priority: 10 }],
    visibleTools: [
      { publicName: `${BACKEND}__read_file`, backendId: BACKEND, allowed: true, reason: 'allow' },
      { publicName: `${BACKEND}__write_file`, backendId: BACKEND, allowed: false, reason: 'deny_by_default' },
    ],
    ...overrides,
  };
}

async function renderDetail(overrides: Partial<Agent> = {}): Promise<void> {
  render(await AgentDetail({ agent: agent(overrides) }));
}

beforeEach(() => {
  listCredentials.mockReset();
  getAgentAccess.mockReset();
  listCredentials.mockResolvedValue([credential]);
  getAgentAccess.mockResolvedValue(access());
});

describe('agent detail page', () => {
  it('shows identity without ever implying a stored token is retrievable', async () => {
    await renderDetail();

    expect(screen.getByText(AGENT)).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('umg_abc123…')).toBeTruthy();
    expect(screen.getByText(/Only its prefix is ever stored or shown again/)).toBeTruthy();
    expect(screen.queryByText(/umg_super_secret/)).toBeNull();
  });

  it('renders the gateway evaluator verdict, including its reason', async () => {
    await renderDetail();

    expect(screen.getByText(`${BACKEND}__read_file`)).toBeTruthy();
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getByText('deny_by_default')).toBeTruthy();
    expect(screen.getByText('read-only')).toBeTruthy();
  });

  it('describes no policies as default-deny, not as a missing screen', async () => {
    getAgentAccess.mockResolvedValue(access({ policies: [] }));

    await renderDetail();

    expect(screen.getByText(/default-deny baseline/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage access policies' }).getAttribute('href')).toBe('/dashboard/policies');
  });

  it('degrades an access failure without hiding the credential controls', async () => {
    getAgentAccess.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderDetail();

    expect(screen.getByText(/Effective access could not be evaluated/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('reports a credentials failure and does not offer a blind issue', async () => {
    listCredentials.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderDetail();

    expect(screen.getByText(/Credentials could not be read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue credential' })).toBeNull();
  });

  it('shows a disabled agent with the enable action', async () => {
    await renderDetail({ enabled: false, status: 'disabled' });

    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('renders metadata entries as label/value rows', async () => {
    await renderDetail({ metadata: { owner: 'rachmat', tier: 2 } });

    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('rachmat')).toBeTruthy();
    expect(screen.getByText('tier')).toBeTruthy();
  });
});
