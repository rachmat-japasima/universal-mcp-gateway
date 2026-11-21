import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '@/lib/api/types';

/**
 * Agent lifecycle actions.
 *
 * The point of these tests is the honesty of the confirmation copy as much as the
 * requests: disabling is not a pause button (it ends live sessions), and delete
 * revokes credentials and drops assignments. An operator who is told otherwise
 * makes a decision on false information.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

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

const { AgentActions } = await import('@/features/agents/agent-actions');

const AGENT = '22222222-2222-4222-8222-222222222222';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: 'claude-code-laptop',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('AgentActions', () => {
  it('offers only the enable/disable state the agent is in', () => {
    const first = render(<AgentActions agent={agent()} />);
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    first.unmount();

    render(<AgentActions agent={agent({ enabled: false, status: 'disabled' })} />);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('posts to the literal disable route and re-reads only after the answer', async () => {
    let release: ((value: unknown) => void) | undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<AgentActions agent={agent()} layout="page" />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}/disable`, { method: 'POST' });
    expect(refresh).not.toHaveBeenCalled();

    release?.({ ok: true, status: 200, data: agent({ enabled: false }) });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('states that disabling ends live sessions, not just new ones', () => {
    render(<AgentActions agent={agent()} layout="page" />);

    expect(screen.getByText(/invalidates the agent's live ones immediately/)).toBeTruthy();
    // And that enabling again does not undo the credential situation.
    expect(screen.getByText(/only the sessions were ended/)).toBeTruthy();
  });

  it('surfaces a rejected action instead of refreshing', async () => {
    send.mockResolvedValue({ ok: false, status: 401, message: 'Your session has expired. Sign in again.' });

    render(<AgentActions agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(screen.getByText('Your session has expired. Sign in again.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables every button while an action is in flight', async () => {
    send.mockImplementation(() => new Promise(() => {}));

    render(<AgentActions agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true'),
    );
    expect(screen.getByRole('button', { name: 'Disable' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('asks before deleting, naming the agent and the blast radius', () => {
    render(<AgentActions agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('Delete claude-code-laptop?')).toBeTruthy();
    expect(screen.getByText(/revokes every credential it holds/)).toBeTruthy();
    expect(screen.getByText(/drops every policy assignment/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not delete when the operator keeps the agent', () => {
    render(<AgentActions agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep agent' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete claude-code-laptop?')).toBeNull();
  });

  it('deletes after confirmation and returns to the list', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { ...agent(), revokedCredentials: 1, removedAssignments: 1 } });

    render(<AgentActions agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/agents'));
    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}`, { method: 'DELETE' });
    // The page's subject is gone, so it is not refreshed into a 404.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('offers an edit link on the detail layout only', () => {
    render(<AgentActions agent={agent()} layout="page" />);
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(`/dashboard/agents/${AGENT}/edit`);
  });
});
