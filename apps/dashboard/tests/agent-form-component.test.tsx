import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '@/lib/api/types';

/**
 * The agent form.
 *
 * Two claims that matter beyond "it renders":
 *
 *  * creating an agent never mints a credential — profile and secret are
 *    separate decisions, and this flow has nowhere to show a token once;
 *  * an edit clears a field with `null` rather than `""`, because the API
 *    distinguishes absence from an empty string.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { AgentForm } = await import('@/features/agents/agent-form');

const AGENT = '22222222-2222-4222-8222-222222222222';

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

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('AgentForm', () => {
  it('creates with POST /api/agents and lands on the new detail page', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: agent() });

    render(<AgentForm />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: ' claude-code-laptop ' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Operator workstation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/agents/${AGENT}`));

    expect(send).toHaveBeenCalledWith('/api/agents', {
      method: 'POST',
      body: { name: 'claude-code-laptop', description: 'Operator workstation', enabled: true },
    });
  });

  it('never requests a credential as part of create', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: agent() });

    render(<AgentForm />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    for (const call of send.mock.calls) {
      expect(String(call[0])).not.toContain('/credentials');
    }
  });

  it('validates locally and sends nothing when the name is blank', async () => {
    render(<AgentForm />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByText('A name is required.')).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
  });

  it('patches on edit, clearing an emptied field with null', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: agent({ description: undefined, clientType: undefined }) });

    render(<AgentForm agent={agent()} />);
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}`, {
      method: 'PATCH',
      body: { name: 'claude-code-laptop', enabled: true, description: null, clientType: 'claude-code' },
    });
    expect(screen.getByText('Saved.')).toBeTruthy();
  });

  it('does not promise a compare-and-set that the API cannot make', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: agent() });

    render(<AgentForm agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(String(send.mock.calls[0]![0])).toBe(`/api/agents/${AGENT}`);
    expect(String(send.mock.calls[0]![0])).not.toContain('expectedVersion');
  });

  it('surfaces a rejected create without navigating', async () => {
    send.mockResolvedValue({ ok: false, status: 409, message: 'An agent with this name already exists.' });

    render(<AgentForm />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByText('An agent with this name already exists.')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });

  it('says that disabling here ends live sessions', () => {
    render(<AgentForm agent={agent()} />);

    expect(screen.getByText(/its live sessions are invalidated when it is disabled/)).toBeTruthy();
  });
});
