import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredential, IssuedCredential } from '@/lib/api/types';

/**
 * The credential panel.
 *
 * This is the one component in the product that holds a raw credential, so the
 * assertions are about where it can go, not only what renders:
 *
 *  * the token appears once, after the gateway answers, and never before;
 *  * it is never written to `localStorage`, `sessionStorage`, a cookie, or the URL;
 *  * "Done" discards it, and nothing can re-render it — the gateway has no
 *    endpoint that returns it again;
 *  * rotation states its real semantics (replace, no grace period) before acting;
 *  * a revoked credential is not offered a rotate button, because the gateway
 *    answers `409`.
 */

const send = vi.fn();
const refresh = vi.fn();

/**
 * jsdom has no `<dialog>` modal implementation, so an `AlertDialog` mounted in a
 * test throws `showModal is not a function`. These stubs are the whole surface
 * Astryx uses; the dialog is real in a browser. `CSS.escape` is likewise absent
 * and is used by Astryx's dev-time a11y warning on open.
 */
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

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const { CredentialPanel } = await import('@/features/agents/credential-panel');

const AGENT = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

function credential(overrides: Partial<AgentCredential> = {}): AgentCredential {
  return {
    id: CREDENTIAL,
    agentId: AGENT,
    name: 'laptop',
    tokenPrefix: 'umg_abc123',
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function issued(token = 'umg_super_secret_value'): IssuedCredential {
  return { ...credential(), token };
}

function renderPanel(credentials: AgentCredential[] = [credential()]): void {
  render(<CredentialPanel agentId={AGENT} agentName="claude-code-laptop" credentials={credentials} />);
}

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('CredentialPanel', () => {
  it('shows metadata only, with the prefix and never a token', () => {
    renderPanel();

    expect(screen.getByText('umg_abc123…')).toBeTruthy();
    expect(screen.queryByText(/super_secret/)).toBeNull();
  });

  it('says plainly that a revoked credential cannot be rotated', () => {
    renderPanel([credential({ status: 'revoked', revokedAt: '2026-11-19T01:00:00.000Z' })]);

    expect(screen.getByText('Revoked — cannot be rotated; issue a new credential instead.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('issues through the agent credential route and shows the token once', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: issued() });

    renderPanel([]);
    expect(screen.getByText(/has no credentials/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => expect(screen.getByText(/will not be shown again/)).toBeTruthy());

    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}/credentials`, { method: 'POST', body: {} });
    // The token is on screen now, and only here.
    expect(screen.getByText('umg_super_secret_value')).toBeTruthy();
    // The list is re-read from the server rather than patched locally.
    expect(refresh).toHaveBeenCalled();
  });

  it('never writes the token to browser storage or the URL', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: issued() });

    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));
    await waitFor(() => expect(screen.getByText('umg_super_secret_value')).toBeTruthy());

    const serialisedStorage = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(serialisedStorage).not.toContain('umg_super_secret_value');
    expect(document.cookie).not.toContain('umg_super_secret_value');
    expect(window.location.href).not.toContain('umg_super_secret_value');
  });

  it('discards the token when the operator is done, and cannot show it again', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: issued() });

    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));
    await waitFor(() => expect(screen.getByText('umg_super_secret_value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Done, hide token' }));

    expect(screen.queryByText('umg_super_secret_value')).toBeNull();
    // Nothing on the page can ask the gateway for it again.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends an expiry only when one was entered, converted to a full instant', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: issued() });

    renderPanel([]);
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: ' build box ' } });
    fireEvent.change(screen.getByLabelText(/Expires at/), { target: { value: '2027-01-01T00:00:00.000Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}/credentials`, {
      method: 'POST',
      body: { name: 'build box', expiresAt: '2027-01-01T00:00:00.000Z' },
    });
  });

  it('refuses an unreadable expiry locally instead of sending a bad body', async () => {
    renderPanel([]);
    fireEvent.change(screen.getByLabelText(/Expires at/), { target: { value: 'next tuesday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => expect(screen.getByText(/expiry date could not be read/)).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim a credential exists when the 201 carried no token', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: undefined });

    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => expect(screen.getByText(/returned no token/)).toBeTruthy());
    expect(screen.queryByText(/will not be shown again/)).toBeNull();
  });

  it('surfaces an issue failure and shows no token panel', async () => {
    send.mockResolvedValue({
      ok: false,
      status: 500,
      message: 'Credential hashing is not configured. The gateway cannot issue a credential.',
    });

    renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => expect(screen.getByText(/hashing is not configured/)).toBeTruthy());
    expect(screen.queryByText(/will not be shown again/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('states replacement semantics, and the lack of a grace period, before rotating', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(screen.getByText(/no grace period/)).toBeTruthy();
    expect(screen.getByText(/opened with it is invalidated/)).toBeTruthy();
    // Nothing happened yet.
    expect(send).not.toHaveBeenCalled();
  });

  it('rotates after confirmation and shows the new token once', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { ...issued('umg_replacement'), id: 'new-id' } });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credential' }));

    await waitFor(() => expect(screen.getByText('umg_replacement')).toBeTruthy());

    expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}/credentials/${CREDENTIAL}/rotate`, {
      method: 'POST',
      body: {},
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('does not rotate when cancelled', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(/no grace period/)).toBeNull();
  });

  it('asks before revoking and states that sessions end', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(screen.getByText(/every session opened with it is invalidated/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('revokes after confirmation and re-reads, without showing a token', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: credential({ status: 'revoked' }) });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke credential' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(`/api/agents/${AGENT}/credentials/${CREDENTIAL}/revoke`, {
      method: 'POST',
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText(/will not be shown again/)).toBeNull();
  });

  it('reports a rejected rotation (revoked elsewhere) instead of retrying', async () => {
    send.mockResolvedValue({
      ok: false,
      status: 409,
      message: 'A revoked credential cannot be rotated.',
    });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credential' }));

    await waitFor(() => expect(screen.getByText('A revoked credential cannot be rotated.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses a second submission while one is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    renderPanel([]);
    const button = screen.getByRole('button', { name: 'Issue credential' });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);

    release?.({ ok: true, status: 201, data: issued() });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('names the agent when there is nothing to revoke yet', () => {
    renderPanel([]);

    const card = screen.getByText(/has no credentials/);
    expect(card.textContent).toContain('claude-code-laptop');
    expect(within(document.body).queryByRole('table')).toBeNull();
  });
});
