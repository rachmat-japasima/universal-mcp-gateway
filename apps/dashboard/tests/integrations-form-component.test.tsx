import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationConnection, IntegrationProvider } from '@/lib/api/types';

/**
 * The connection create form.
 *
 * The claim that matters beyond "it renders": creating a connection takes no
 * secret. The token has its own write-only step on the detail page, and this
 * form has nowhere to put one — the POST body is `providerId` and `name`,
 * nothing else, even if a caller adds fields.
 */

const send = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { ConnectionForm } = await import('@/features/integrations/connection-form');

const CONNECTION = '44444444-4444-4444-8444-444444444444';

function provider(): IntegrationProvider {
  return {
    id: 'github',
    name: 'GitHub',
    description: 'Read-only GitHub access.',
    capabilities: ['discovery', 'execution'],
    metadata: { authMethod: 'fine-grained personal access token' },
    registeredAt: '2026-11-20T00:00:00.000Z',
  };
}

function connection(): IntegrationConnection {
  return {
    id: CONNECTION,
    providerId: 'github',
    name: 'org-repos',
    status: 'pending',
    credentialId: null,
    metadata: {},
    validatedAt: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  };
}

beforeEach(() => {
  send.mockReset();
  push.mockReset();
  refresh.mockReset();
});

describe('ConnectionForm', () => {
  it('pre-selects the one registered provider, because there is nothing else to choose', () => {
    render(<ConnectionForm providers={[provider()]} />);
    // The trigger shows the selection; the closed option list also holds the
    // name, so "somewhere on the form" is the honest assertion.
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0);
  });

  it('creates with POST and lands on the new connection, whose status is Pending', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: connection() });

    render(<ConnectionForm providers={[provider()]} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: ' org-repos ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/integrations/${CONNECTION}`));

    expect(send).toHaveBeenCalledWith('/api/integrations/connections', {
      method: 'POST',
      body: { providerId: 'github', name: 'org-repos' },
    });
  });

  it('sends no credential-shaped field even if the operator has one on the clipboard', async () => {
    send.mockResolvedValue({ ok: true, status: 201, data: connection() });

    render(<ConnectionForm providers={[provider()]} />);
    // The only text field is the name; a pasted token would land here and be
    // sent as a name, which the gateway stores verbatim — so the form's one
    // field must be all this flow ever offers.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'github_pat_pasted_by_mistake' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    const body = (send.mock.calls[0] as unknown[])[1] as { body: Record<string, unknown> };
    expect(Object.keys(body.body).sort()).toEqual(['name', 'providerId']);
  });

  it('validates locally and sends nothing when the name is blank', async () => {
    render(<ConnectionForm providers={[provider()]} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(screen.getByText('A name is required.')).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('asks for a provider when the registry offers more than one and none is chosen', async () => {
    render(
      <ConnectionForm
        providers={[provider(), { ...provider(), id: 'fixture-api', name: 'Fixture API' }]}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(screen.getByText('Choose a provider.')).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
  });

  it('stays on the form and says what happened when the gateway refuses', async () => {
    send.mockResolvedValue({ ok: false, status: 404, message: 'Unknown providerId.' });

    render(<ConnectionForm providers={[provider()]} />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'org-repos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(screen.getByText('Unknown providerId.')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });
});
