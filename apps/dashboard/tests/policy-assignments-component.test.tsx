import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '@/lib/api/types';

/**
 * Policy assignments.
 *
 * Claims pinned here:
 *
 *  * assign and unassign go to the policy's assignment sub-resource, with the
 *    agent as a body field (`POST`) or path segment (`DELETE`);
 *  * removing an assignment is confirmed and states that the agent loses access
 *    immediately — it is a withdrawal, not a bookmark;
 *  * the picker excludes agents that already hold the policy and says so when
 *    nobody is left, rather than offering a click that would be a no-op;
 *  * a rejected request is reported, never followed by a refresh that would imply
 *    it worked.
 */

const send = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (character) => `\\${character}`) },
  });
}

const { PolicyAssignments } = await import('@/features/policies/policy-assignments');

const POLICY = '77777777-7777-4777-8777-777777777777';
const AGENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function agent(overrides: Partial<Agent> = {}): Agent {
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

function renderPanel(assignments: Agent[] = [agent()], agents = [{ id: AGENT, name: 'claude-code-laptop' }, { id: OTHER, name: 'codex-box' }]): void {
  render(<PolicyAssignments policyId={POLICY} policyName="read-only" assignments={assignments} agents={agents} />);
}

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
});

describe('PolicyAssignments', () => {
  it('links each assigned agent to its own page', () => {
    renderPanel();

    const link = screen.getByRole('link', { name: 'claude-code-laptop' });
    expect(link.getAttribute('href')).toBe(`/dashboard/agents/${AGENT}`);
  });

  it('assigns through the policy sub-resource and re-reads afterwards', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: {} });

    renderPanel();
    fireEvent.change(screen.getByLabelText('Assign to agent'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign policy' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(`/api/policies/${POLICY}/assignments`, {
      method: 'POST',
      body: { agentId: OTHER },
    });
  });

  it('offers only agents that do not already hold the policy', () => {
    renderPanel();

    const select = screen.getByLabelText('Assign to agent') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain(AGENT);
    expect(values).toContain(OTHER);
  });

  it('says so when every agent already holds the policy', () => {
    renderPanel([agent({ id: OTHER, name: 'codex-box' })], [{ id: OTHER, name: 'codex-box' }]);

    expect(screen.getByText('Every agent already holds this policy')).toBeTruthy();
  });

  it('does nothing when no agent is chosen', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Assign policy' }));

    expect(send).not.toHaveBeenCalled();
  });

  it('names the consequence before removing an assignment', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('Remove claude-code-laptop from read-only?')).toBeTruthy();
    expect(screen.getByText(/immediately loses every rule in this policy/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not unassign when the operator keeps the assignment', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep assignment' }));

    expect(send).not.toHaveBeenCalled();
  });

  it('unassigns with DELETE on the pair after confirmation', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: {} });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(`/api/policies/${POLICY}/assignments/${AGENT}`, { method: 'DELETE' });
  });

  it('reports a rejected unassign instead of refreshing', async () => {
    send.mockResolvedValue({
      ok: false,
      status: 404,
      message: 'The agent is not assigned to that policy.',
    });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));

    await waitFor(() => expect(screen.getByText('The agent is not assigned to that policy.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('states that the policy currently applies to nobody when unassigned', () => {
    renderPanel([]);

    expect(screen.getByText(/its rules currently apply to nobody/)).toBeTruthy();
  });

  it('disables every control while one request is in flight', async () => {
    send.mockImplementation(() => new Promise(() => {}));

    renderPanel();
    fireEvent.change(screen.getByLabelText('Assign to agent'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign policy' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove' }).getAttribute('aria-disabled')).toBe('true'),
    );
    expect(screen.getByLabelText('Assign to agent').hasAttribute('disabled')).toBe(true);
  });
});
