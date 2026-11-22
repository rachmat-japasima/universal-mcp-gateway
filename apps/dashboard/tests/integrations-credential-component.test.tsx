import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationConnection } from '@/lib/api/types';

/**
 * The provider credential panel — the one component in the dashboard that
 * holds a provider token. The assertions are about where the token can go:
 *
 *  * the field is cleared after the submit answers, success or failure, so the
 *    token never outlives the request in component state;
 *  * it is never written to `localStorage`, `sessionStorage`, a cookie, or the
 *    URL, and never rendered back after the answer;
 *  * storing is not connecting: the announcement says the token is unproven;
 *  * replacing asks first, because the previous envelope dies in the same
 *    transaction;
 *  * `test` is data either way — a rejected token is an answer on the page,
 *    never a thrown error.
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

const { CredentialPanel } = await import('@/features/integrations/credential-panel');

const CONNECTION = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'github_pat_fixture_secret_value';

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: CONNECTION,
    providerId: 'github',
    providerName: 'GitHub',
    name: 'org-repos',
    status: 'pending',
    credentialId: null,
    metadata: {},
    validatedAt: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('CredentialPanel', () => {
  it('stores the token through the write-only route and clears the field', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection({ credentialId: 'cred-1' }) });

    render(<CredentialPanel connection={connection()} />);
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Store token' }));

    await waitFor(() => expect(screen.getByText('Token sealed in the vault.')).toBeTruthy());

    expect(send).toHaveBeenCalledWith(`/api/integrations/connections/${CONNECTION}/credential`, {
      method: 'POST',
      body: { token: TOKEN },
    });
    // The field is cleared with the answer — the token does not outlive the
    // submit in component state.
    expect((screen.getByLabelText(/Access token/) as HTMLInputElement).value).toBe('');
    // And the token itself never appears on the page: the answer is the row,
    // whose only credential fact is a vault reference.
    expect(screen.queryByText(TOKEN)).toBeNull();
  });

  it('says storing proves nothing, rather than pretending the connection works', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection({ credentialId: 'cred-1' }) });

    render(<CredentialPanel connection={connection()} />);
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Store token' }));

    await waitFor(() => expect(screen.getByText(/Storing proves nothing/)).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });

  it('never writes the token to browser storage, a cookie, or the URL', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection({ credentialId: 'cred-1' }) });

    render(<CredentialPanel connection={connection()} />);
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Store token' }));
    await waitFor(() => expect(screen.getByText('Token sealed in the vault.')).toBeTruthy());

    const serialisedStorage = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(serialisedStorage).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('clears the field even when the store is refused', async () => {
    send.mockResolvedValue({ ok: false, status: 400, message: 'The token could not be stored.' });

    render(<CredentialPanel connection={connection()} />);
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Store token' }));

    await waitFor(() => expect(screen.getByText('The token could not be stored.')).toBeTruthy());
    expect((screen.getByLabelText(/Access token/) as HTMLInputElement).value).toBe('');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('offers no test before a token exists, and says so', () => {
    render(<CredentialPanel connection={connection()} />);

    expect(screen.getByRole('button', { name: 'Test token' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Test needs a stored token/)).toBeTruthy();
  });

  it('answers a refused test as data, naming what to do next', async () => {
    send.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: false, kind: 'reauthorization_required', message: 'GitHub rejected the token.' },
    });

    render(<CredentialPanel connection={connection({ status: 'reauthorization_required', credentialId: 'cred-1' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test token' }));

    await waitFor(() => expect(screen.getByText('The token was rejected.')).toBeTruthy());
    // The refused test names the next step in the connector's own words.
    expect(screen.getByText('Store a new token to continue.')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('answers a working test as data', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

    render(<CredentialPanel connection={connection({ status: 'connected', credentialId: 'cred-1' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test token' }));

    await waitFor(() => expect(screen.getByText('The token works.')).toBeTruthy());
  });

  it('asks before replacing, because the previous envelope dies in the same transaction', () => {
    render(<CredentialPanel connection={connection({ credentialId: 'cred-1', status: 'connected' })} />);

    expect(screen.getByText(/no grace period/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Replacement token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));

    expect(screen.getByText('Replace the stored token?')).toBeTruthy();
    expect(screen.getByText(/deleted in the same transaction/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep current token' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('replaces after confirmation and clears the field', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: connection({ credentialId: 'cred-2', status: 'connected' }) });

    render(<CredentialPanel connection={connection({ credentialId: 'cred-1', status: 'connected' })} />);
    fireEvent.change(screen.getByLabelText(/Replacement token/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace the stored token' }));

    await waitFor(() => expect(screen.getByText('Token replaced.')).toBeTruthy());
    expect((screen.getByLabelText(/Replacement token/) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(TOKEN)).toBeNull();
  });

  it('names the GitHub token scope the gateway actually asks for', () => {
    render(<CredentialPanel connection={connection()} />);

    expect(screen.getByText(/Metadata, Issues and Pull requests/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /personal-access-tokens/ });
    expect(link.getAttribute('href')).toBe('https://github.com/settings/personal-access-tokens');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('names the Notion capability and the sharing step a fresh connection needs', () => {
    render(
      <CredentialPanel
        connection={connection({ providerId: 'notion', providerName: 'Notion', name: 'team-wiki' })}
      />,
    );

    // Read content only — the least privilege the six tools need.
    expect(screen.getByText(/Read content only/)).toBeTruthy();
    // The sharing-pages explanation: a connection sees nothing by default.
    expect(screen.getByText(/sees nothing until content is shared/)).toBeTruthy();
    expect(screen.getByText(/Content access tab/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Notion developer portal/ });
    expect(link.getAttribute('href')).toBe('https://app.notion.com/developers/connections');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    // The GitHub hint stays where it belongs: on GitHub connections.
    expect(screen.queryByText(/Metadata, Issues and Pull requests/)).toBeNull();
  });
});
