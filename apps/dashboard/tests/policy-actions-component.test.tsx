import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Policy } from '@/lib/api/types';

/**
 * Policy delete.
 *
 * A policy delete is a hard delete that cascades to assignments, so the dialog
 * must say what is withdrawn and that it cannot be undone. The page's subject is
 * gone afterwards, so the list is where the operator lands — refreshing the
 * detail page would be a `404`.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

const { PolicyActions } = await import('@/features/policies/policy-actions');

const POLICY = '77777777-7777-4777-8777-777777777777';

const policy: Policy = {
  id: POLICY,
  name: 'read-only',
  priority: 10,
  rules: [],
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
};

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('PolicyActions', () => {
  it('links to the edit page', () => {
    render(<PolicyActions policy={policy} />);

    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(`/dashboard/policies/${POLICY}/edit`);
  });

  it('asks first, naming the cascade and the lack of undo', () => {
    render(<PolicyActions policy={policy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('Delete read-only?')).toBeTruthy();
    expect(screen.getByText(/every agent that holds it loses its rules immediately/)).toBeTruthy();
    expect(screen.getByText(/no undo/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the policy when the operator backs out', () => {
    render(<PolicyActions policy={policy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep policy' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete read-only?')).toBeNull();
  });

  it('deletes after confirmation and returns to the list, not a 404', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: policy });

    render(<PolicyActions policy={policy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete policy' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/policies'));
    expect(send).toHaveBeenCalledWith(`/api/policies/${POLICY}`, { method: 'DELETE' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a rejected delete and stays on the page', async () => {
    send.mockResolvedValue({ ok: false, status: 403, message: 'You do not have permission to do that.' });

    render(<PolicyActions policy={policy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete policy' }));

    await waitFor(() => expect(screen.getByText('You do not have permission to do that.')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a second submission while one is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<PolicyActions policy={policy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const action = screen.getByRole('button', { name: 'Delete policy' });
    fireEvent.click(action);
    await waitFor(() => expect(action.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(action);
    expect(send).toHaveBeenCalledTimes(1);

    release?.({ ok: true, status: 200, data: policy });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });
});
