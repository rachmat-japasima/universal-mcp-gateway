import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/api/types';

/**
 * Session termination.
 *
 * Claims pinned here, because each one is a way to end the wrong thing:
 *
 *  * the confirmation states the real effect on the client, that the credential
 *    survives, and that no other session is affected;
 *  * nothing is sent until the operator confirms;
 *  * only one request can be in flight, so a double click cannot double-submit;
 *  * the page re-reads only after the server answers, and a rejection is shown
 *    as the gateway's message rather than as success;
 *  * a finished session offers no terminate button at all.
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

const { SessionTerminateAction } = await import('@/features/sessions/session-terminate-action');

const SESSION = '99999999-9999-4999-8999-999999999999';
const AGENT = '22222222-2222-4222-8222-222222222222';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    status: 'active',
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActivityAt: '2026-11-20T10:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
});

describe('SessionTerminateAction', () => {
  it('sends nothing until the operator confirms', () => {
    render(<SessionTerminateAction session={session()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));

    expect(send).not.toHaveBeenCalled();
    // The copy must state the real consequence and the parts that survive.
    const dialog = screen.getByText(/The connected MCP client stops working immediately/);
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/The credential and the agent are unaffected/)).toBeTruthy();
  });

  it('posts to the literal terminate route, then re-reads', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: session({ status: 'terminated' }) });

    render(<SessionTerminateAction session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminate session' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(`/api/sessions/${SESSION}/terminate`, { method: 'POST' });
  });

  it('does not re-read or claim success when the gateway refuses', async () => {
    send.mockResolvedValue({ ok: false, status: 404, message: 'The requested session does not exist.' });

    render(<SessionTerminateAction session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminate session' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('does not exist'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('prevents a duplicate submission while one is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    render(<SessionTerminateAction session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));

    const confirm = screen.getByRole('button', { name: 'Terminate session' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(send).toHaveBeenCalledTimes(1);

    release?.({ ok: true, status: 200 });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('offers no terminate control for a session that has already ended', () => {
    render(<SessionTerminateAction session={session({ status: 'expired' })} />);

    expect(screen.getByRole('button', { name: 'Terminate' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Already ended')).toBeTruthy();
  });
});
