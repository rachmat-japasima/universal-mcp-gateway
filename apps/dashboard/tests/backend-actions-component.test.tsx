import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend, BackendRuntimeStatus } from '@/lib/api/types';

/**
 * The lifecycle action bar.
 *
 * The four things pinned here are all about not lying to an operator:
 *
 *  * only actions the gateway would accept are offered (a disabled backend has
 *    no `Connect`);
 *  * write paths carry `expectedVersion` for the compare-and-set actions and not
 *    for the ones that do not take it;
 *  * nothing is reported as done before the proxy answers, and a failure is
 *    surfaced instead of the page silently refreshing;
 *  * delete asks first, names the subject, and then leaves for the list — not a
 *    refresh of a page whose backend no longer exists.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/backends/browser', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { BackendActions } = await import('@/features/backends/backend-actions');

/**
 * jsdom implements `<dialog>` without the modal methods (it has no top layer),
 * so a dialog-mounted component throws `showModal is not a function`. These two
 * stubs are the whole surface Astryx uses; the dialog is real in a browser.
 */
if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

// jsdom has no `CSS.escape`; Astryx's dev-time a11y warning uses it on open.
if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (character) => `\\${character}`) },
  });
}

const ID = '11111111-1111-4111-8111-111111111111';

function backend(status: BackendRuntimeStatus = 'disconnected', enabled = true): Backend {
  return {
    id: ID,
    name: 'filesystem',
    transport: 'stdio',
    connection: { type: 'stdio', command: 'npx', args: [], env: {} },
    enabled,
    timeoutMs: 30000,
    concurrencyMode: 'serialized',
    version: 5,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    runtime: { status, updatedAt: '2026-11-19T00:00:00.000Z' },
  };
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('BackendActions', () => {
  it('offers connect and not disconnect on a resting backend', () => {
    render(<BackendActions backend={backend()} />);

    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('offers disconnect and not connect while connected', () => {
    render(<BackendActions backend={backend('connected')} />);

    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('offers enable but never connect or reconnect on a disabled backend', () => {
    render(<BackendActions backend={backend('disabled', false)} />);

    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('posts connect to the proxy and refreshes only after it answers', async () => {
    let resolve: (value: unknown) => void = () => {};
    send.mockImplementation(() => new Promise((settle) => (resolve = settle)));

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(send).toHaveBeenCalledWith(`/api/backends/${ID}/connect`, { method: 'POST' });
    // Nothing is refreshed before the gateway has answered.
    expect(refresh).not.toHaveBeenCalled();

    resolve({ ok: true, status: 200, data: { backendId: ID, status: 'connected' } });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('sends the rendered version for enable and disable', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: {} });

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(`/api/backends/${ID}/disable?expectedVersion=5`, { method: 'POST' });
  });

  it('surfaces a rejected action instead of refreshing', async () => {
    send.mockResolvedValue({
      ok: false,
      status: 409,
      message: 'The backend changed since this page was rendered. Reload and try again.',
    });

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    expect(
      await screen.findByText('The backend changed since this page was rendered. Reload and try again.'),
    ).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables every button while an action is in flight', async () => {
    send.mockImplementation(() => new Promise(() => {}));

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Disable' }).getAttribute('aria-disabled')).toBe('true'),
    );
    // The in-flight action itself is disabled too, so it cannot be retried.
    expect(screen.getByRole('button', { name: 'Connect' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('asks before deleting, naming the backend and its consequence', () => {
    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('Delete filesystem?')).toBeTruthy();
    expect(screen.getByText(/tombstoned rather than erased/)).toBeTruthy();
    // The dialog is the only path to DELETE.
    expect(send).not.toHaveBeenCalled();
  });

  it('does not delete when the operator keeps the backend', () => {
    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep backend' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete filesystem?')).toBeNull();
  });

  it('deletes after confirmation and navigates to the list', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { id: ID } });

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete backend' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/backends'));
    expect(send).toHaveBeenCalledWith(`/api/backends/${ID}`, { method: 'DELETE' });
    // A deleted subject is gone; refreshing a page about it would be a stale read.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the dialog with the reason when the delete is refused', async () => {
    send.mockResolvedValue({ ok: false, status: 409, message: 'The backend is in use.' });

    render(<BackendActions backend={backend()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete backend' }));

    expect(await screen.findByText('The backend is in use.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
