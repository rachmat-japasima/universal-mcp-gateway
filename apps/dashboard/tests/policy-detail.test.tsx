import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentAccess, Policy } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * Policy detail.
 *
 * The claims that matter:
 *
 *  * rules are rendered with the word ALLOW/DENY, not colour alone;
 *  * a wildcard allow is called out as broad access at the page top;
 *  * the effective-access preview calls `GET /agents/:id/access` — the gateway's
 *    evaluator — and renders its verdict, `reason` included;
 *  * a preview for an agent that does not hold the policy is refused rather than
 *    evaluated, so the page cannot imply this policy affects that agent;
 *  * an assignments read failure does not hide the rules.
 */

const listPolicyAssignments = vi.fn();
const listAgents = vi.fn();
const getAgentAccess = vi.fn();

vi.mock('@/lib/api/policies', () => ({
  listPolicyAssignments: (...args: unknown[]) => listPolicyAssignments(...args),
}));
vi.mock('@/lib/api/agents', () => ({
  listAgents: (...args: unknown[]) => listAgents(...args),
  getAgentAccess: (...args: unknown[]) => getAgentAccess(...args),
}));
vi.mock('@/lib/api/write-client', () => ({ send: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { PolicyDetail } = await import('@/features/policies/policy-detail');

const POLICY = '77777777-7777-4777-8777-777777777777';
const AGENT = '22222222-2222-4222-8222-222222222222';
const BACKEND = '11111111-1111-4111-8111-111111111111';

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: POLICY,
    name: 'read-only',
    description: 'Read tools only',
    priority: 10,
    rules: [
      { resource: 'backend', target: BACKEND, effect: 'allow' },
      { resource: 'tool', target: 'github__delete', effect: 'deny' },
    ],
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

const assigned: Agent = {
  id: AGENT,
  name: 'claude-code-laptop',
  enabled: true,
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
};

function access(overrides: Partial<AgentAccess> = {}): AgentAccess {
  return {
    agentId: AGENT,
    policies: [{ id: POLICY, name: 'read-only', priority: 10 }],
    visibleTools: [
      { publicName: 'github__read', backendId: BACKEND, allowed: true, reason: 'allow' },
      { publicName: 'github__delete', backendId: BACKEND, allowed: false, reason: 'explicit_deny' },
    ],
    ...overrides,
  };
}

async function renderDetail({
  overrides = {},
  previewAgentId,
}: { overrides?: Partial<Policy>; previewAgentId?: string } = {}): Promise<void> {
  render(
    await PolicyDetail({
      policy: policy(overrides),
      backends: [{ id: BACKEND, name: 'github' }],
      ...(previewAgentId === undefined ? {} : { previewAgentId }),
    }),
  );
}

beforeEach(() => {
  listPolicyAssignments.mockReset();
  listAgents.mockReset();
  getAgentAccess.mockReset();
  listPolicyAssignments.mockResolvedValue([assigned]);
  listAgents.mockResolvedValue({ data: [assigned], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } });
  getAgentAccess.mockResolvedValue(access());
});

describe('policy detail', () => {
  it('renders effects as words, so meaning does not depend on colour', async () => {
    await renderDetail();

    expect(screen.getByText('ALLOW')).toBeTruthy();
    expect(screen.getByText('DENY')).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('github__delete')).toBeTruthy();
  });

  it('names the backend a rule targets, while keeping the id it stored', async () => {
    await renderDetail();

    // Both: the id is what the gateway evaluates, the name is what an operator
    // recognises. Showing only the name would hide what the rule really says.
    expect(screen.getByText(BACKEND)).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
  });

  it('says a rule target is not in the registry rather than hiding it', async () => {
    render(
      await PolicyDetail({
        policy: policy({ rules: [{ resource: 'backend', target: '00000000-0000-4000-8000-000000000000', effect: 'allow' }] }),
        backends: [],
      }),
    );

    expect(screen.getByText(/Not in the current registry/)).toBeTruthy();
  });

  it('calls out a wildcard allow as broad access at the top of the page', async () => {
    await renderDetail({
      overrides: { rules: [{ resource: 'tool', target: '*', effect: 'allow' }] },
    });

    expect(screen.getByText(/This policy contains 1 ALLOW rule with target/)).toBeTruthy();
  });

  it('does not claim broad access when only a wildcard DENY is present', async () => {
    await renderDetail({
      overrides: { rules: [{ resource: 'tool', target: '*', effect: 'deny' }] },
    });

    expect(screen.queryByText(/This policy contains/)).toBeNull();
  });

  it('says a ruleless policy grants nothing', async () => {
    await renderDetail({ overrides: { rules: [] } });

    expect(screen.getByText(/This policy has no rules, so it grants nothing to anyone/)).toBeTruthy();
    expect(screen.getByText('0 allow · 0 deny (0 total)')).toBeTruthy();
  });

  it('prompts for an agent rather than guessing one', async () => {
    await renderDetail();

    expect(screen.getByText(/Pick an agent that holds this policy/)).toBeTruthy();
    expect(getAgentAccess).not.toHaveBeenCalled();
  });

  it("previews an assigned agent's access from the gateway evaluator, reason included", async () => {
    await renderDetail({ previewAgentId: AGENT });

    expect(getAgentAccess).toHaveBeenCalledWith(AGENT);
    expect(screen.getByText('github__read')).toBeTruthy();
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('explicit_deny')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open this agent' }).getAttribute('href')).toBe(
      `/dashboard/agents/${AGENT}`,
    );
  });

  it('refuses to preview an agent that does not hold the policy', async () => {
    await renderDetail({ previewAgentId: '99999999-9999-4999-8999-999999999999' });

    expect(getAgentAccess).not.toHaveBeenCalled();
    expect(screen.getByText(/does not hold this policy/)).toBeTruthy();
  });

  it('reports an evaluator failure without pretending access is empty', async () => {
    getAgentAccess.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderDetail({ previewAgentId: AGENT });

    expect(screen.getByText(/Effective access could not be evaluated/)).toBeTruthy();
    expect(screen.queryByText(/Every tool is denied/)).toBeNull();
  });

  it('degrades an assignments failure without hiding the rules', async () => {
    listPolicyAssignments.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderDetail();

    expect(screen.getByText(/Assignments could not be read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign policy' })).toBeNull();
    // The rules are still on screen, because they are a separate read.
    expect(screen.getByText('ALLOW')).toBeTruthy();
  });

  it('survives an agent-list failure, because the preview is optional', async () => {
    listAgents.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderDetail();

    expect(screen.getByText('ALLOW')).toBeTruthy();
    expect(screen.getByText(/Assignments/)).toBeTruthy();
  });

  it('offers a real GET form so a preview is reproducible in the URL', async () => {
    await renderDetail();

    const select = screen.getByLabelText('Agent') as HTMLSelectElement;
    expect(select.closest('form')!.getAttribute('method')).toBe('get');
    expect(Array.from(select.options).map((option) => option.value)).toContain(AGENT);
  });
});
