import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationConnection } from '@/lib/api/types';

/**
 * Connection lifecycle actions.
 *
 * The assertions are about the honesty of the surface as much as the requests:
 * `enable` is the only path to connected (and the only exit from disabled, the
 * only reconnect, and — on a live connection — the refresh, reported as a
 * diff), disable and disconnect state that tools are withdrawn immediately,
 * and delete names the hard-delete cascade. An operator told otherwise makes
 * a decision on false information.
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

const { ConnectionActions } = await import('@/features/integrations/connection-actions');

const CONNECTION = '44444444-4444-4444-8444-444444444444';

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: CONNECTION,
    providerId: 'github',
    providerName: 'GitHub',
    name: 'org-repos',
    status: 'connected',
    credentialId: '22222222-2222-4222-8222-222222222222',
    metadata: {},
    validatedAt: '2026-11-21T00:00:00.000Z',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

function enableOutcome(added: number, removed = 0): unknown {
  return {
    ok: true,
    status: 200,
    data: {
      connection: connection({ status: 'connected' }),
      tools: {
        added: Array.from({ length: added }, (_, index) => `tool_${index}`),
        removed: Array.from({ length: removed }, (_, index) => `gone_${index}`),
        changed: [],
      },
    },
  };
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('ConnectionActions', () => {
  it('offers only the buttons the status makes honest', () => {
    const connected = render(<ConnectionActions connection={connection()} />);
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    connected.unmount();

    render(<ConnectionActions connection={connection({ status: 'pending', credentialId: null, validatedAt: null })} />);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('names the reconnect exits for what they are', () => {
    const disconnected = render(
      <ConnectionActions connection={connection({ status: 'disconnected', validatedAt: null })} />,
    );
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    disconnected.unmount();

    render(<ConnectionActions connection={connection({ status: 'disabled', validatedAt: null })} />);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
  });

  it('connects through the enable route and says what published', async () => {
    send.mockResolvedValue(enableOutcome(6));

    render(<ConnectionActions connection={connection({ status: 'pending', credentialId: null, validatedAt: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Connected. 6 tools published.')).toBeTruthy());
    expect(send).toHaveBeenCalledWith(`/api/integrations/connections/${CONNECTION}/enable`, { method: 'POST' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('says when a connect published nothing, rather than showing nothing', async () => {
    send.mockResolvedValue(enableOutcome(0));

    render(<ConnectionActions connection={connection({ status: 'pending', credentialId: null, validatedAt: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Connected. No tools published.')).toBeTruthy());
  });

  it('refreshes a connected connection through the same route and reports the diff', async () => {
    send.mockResolvedValue(enableOutcome(1, 2));

    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.getByText('Refreshed. 1 new tool, 2 removed.')).toBeTruthy());
    expect(send).toHaveBeenCalledWith(`/api/integrations/connections/${CONNECTION}/enable`, { method: 'POST' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces a refused enable instead of announcing success', async () => {
    send.mockResolvedValue({ ok: false, status: 502, message: 'GitHub rejected the token.' });

    render(<ConnectionActions connection={connection({ status: 'reauthorization_required', validatedAt: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => expect(screen.getByText('GitHub rejected the token.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('asks before disabling, stating that tools are withdrawn immediately', () => {
    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(screen.getByText('Disable org-repos?')).toBeTruthy();
    expect(screen.getByText(/withdrawn immediately/)).toBeTruthy();
    expect(screen.getByText(/Enable is the way back/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('asks before disconnecting, stating that reconnect re-proves the token', () => {
    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(screen.getByText('Disconnect org-repos?')).toBeTruthy();
    expect(screen.getByText(/verification handshake again/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when the operator keeps the connection', () => {
    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Disable org-repos?')).toBeNull();
  });

  it('disconnects after confirmation and re-reads the row', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection({ status: 'disconnected' }) });

    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect connection' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(`/api/integrations/connections/${CONNECTION}/disconnect`, { method: 'POST' });
  });

  it('asks before deleting, naming the hard delete and the credential cascade', () => {
    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('Delete org-repos?')).toBeTruthy();
    expect(screen.getByText(/sealed credential is destroyed/)).toBeTruthy();
    expect(screen.getByText(/no tombstone and no undo/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes after confirmation and returns to the list', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection() });

    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/integrations'));
    expect(send).toHaveBeenCalledWith(`/api/integrations/connections/${CONNECTION}`, { method: 'DELETE' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables every button while an action is in flight', async () => {
    send.mockImplementation(() => new Promise(() => {}));

    render(<ConnectionActions connection={connection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true'));
  });
});
