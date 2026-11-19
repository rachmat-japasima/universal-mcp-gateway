import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend } from '@/lib/api/types';

/**
 * The create/edit form.
 *
 * The behaviours pinned here are the ones an operator would notice as either a
 * lie or a hazard:
 *
 *  * the transport switch must actually swap the fields, so a Streamable HTTP
 *    backend cannot be saved with a stdio executable;
 *  * a client-side failure must stop before any request is sent;
 *  * a secret-shaped value must be refused rather than submitted;
 *  * success is only reported after the proxy answers, and creation navigates to
 *    the new backend's detail page rather than assuming one.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/backends/browser', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { BackendForm } = await import('@/features/backends/backend-form');

const ID = '11111111-1111-4111-8111-111111111111';

function existing(): Backend {
  return {
    id: ID,
    name: 'filesystem',
    description: 'Local files',
    transport: 'stdio',
    connection: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret:fs/token' } },
    enabled: true,
    timeoutMs: 30000,
    concurrencyMode: 'serialized',
    version: 4,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  };
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('BackendForm', () => {
  it('starts on the stdio fields and shows the http fields only after switching', () => {
    render(<BackendForm />);

    expect(screen.getByLabelText(/^Executable/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Endpoint URL/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Streamable HTTP' }));

    expect(screen.getByLabelText(/^Endpoint URL/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Executable/)).toBeNull();
    expect(screen.getByText(/Request headers/)).toBeTruthy();
  });

  it('does not send anything when the name is missing', async () => {
    render(<BackendForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    expect(await screen.findByText('Fix the highlighted fields before saving.')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a shell-looking executable before submitting', async () => {
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'node server.js' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    expect(await screen.findByText(/Enter one executable only/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a literal secret value and says what to use instead', async () => {
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add environment entry' }));
    fireEvent.change(screen.getByLabelText('Variable name 1'), { target: { value: 'API_KEY' } });
    fireEvent.change(screen.getByLabelText('Variable name 1 reference'), {
      target: { value: 'sk-live-abcdef' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    expect(await screen.findByText(/Use a reference/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('creates a backend and navigates to its detail page', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: { id: ID } });
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/backends/${ID}`));
    expect(send).toHaveBeenCalledWith('/api/backends', {
      method: 'POST',
      body: expect.objectContaining({
        name: 'fs',
        connection: { type: 'stdio', command: 'npx', args: [], env: {} },
      }),
    });
  });

  it('reports the gateway error and stays on the form', async () => {
    send.mockResolvedValue({ ok: false, status: 409, message: 'A backend with that name already exists.' });
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    expect(await screen.findByText('A backend with that name already exists.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('seeds the edit form from the saved backend and sends the rendered version', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: existing() });
    render(<BackendForm backend={existing()} />);

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('filesystem');
    expect((screen.getByLabelText(/^Description/) as HTMLTextAreaElement).value).toBe('Local files');
    expect((screen.getByLabelText('Variable name 1') as HTMLInputElement).value).toBe('TOKEN');
    // The reference is shown; no secret value exists to show.
    expect((screen.getByLabelText('Variable name 1 reference') as HTMLInputElement).value).toBe('secret:fs/token');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(`/api/backends/${ID}?expectedVersion=4`, {
      method: 'PATCH',
      body: expect.objectContaining({ name: 'filesystem', description: 'Local files', concurrencyLimit: null }),
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('validates through the gateway without saving', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { valid: true, transport: 'stdio' } });
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate configuration' }));

    expect(await screen.findByText(/The gateway accepted this configuration/)).toBeTruthy();
    expect(send).toHaveBeenCalledWith('/api/backends/validate', expect.objectContaining({ method: 'POST' }));
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps validation issues onto the fields', async () => {
    send.mockResolvedValue({
      ok: true,
      status: 200,
      data: { valid: false, errors: [{ path: 'connection.command', message: 'command must be a single executable' }] },
    });
    render(<BackendForm />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate configuration' }));

    expect(await screen.findByText('command must be a single executable')).toBeTruthy();
  });

  it('disables the actions while a save is in flight, so it cannot be submitted twice', async () => {
    let resolve: (value: unknown) => void = () => {};
    send.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );

    render(<BackendForm />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Executable/), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create backend' }));

    // Astryx `Button` sets `aria-disabled`, not the native attribute, and keeps
    // the click handler; the form's own re-entry guard is what stops the second
    // request, so both are asserted.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Validate configuration' }).getAttribute('aria-disabled')).toBe('true'),
    );

    // A second submit while pending must not produce a second request.
    fireEvent.submit(screen.getByRole('button', { name: 'Create backend' }).closest('form')!);
    expect(send).toHaveBeenCalledTimes(1);

    resolve({ ok: true, status: 201, data: { id: ID } });
    await waitFor(() => expect(push).toHaveBeenCalled());
  });
});
