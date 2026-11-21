import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolRefreshResult } from '@/lib/api/types';

/**
 * The catalog refresh control.
 *
 * Refresh is the only write the tool explorer has, and it is not free — it dials
 * every backend. So: one request in flight at a time, nothing reported before the
 * gateway answers, and a partial failure reported as a partial failure rather
 * than a success with a footnote.
 */

const send = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/api/write-client', () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const { ToolRefresh } = await import('@/features/tools/tool-refresh');

const BACKEND = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  send.mockReset();
  refresh.mockReset();
});

describe('ToolRefresh', () => {
  it('posts to the global refresh route and re-reads the page on success', async () => {
    const result: ToolRefreshResult = { refreshed: 2, failed: 0, results: [] };
    send.mockResolvedValue({ ok: true, status: 200, data: result });

    render(<ToolRefresh />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

    await waitFor(() => expect(screen.getByText('Refreshed 2 backends.')).toBeTruthy());

    expect(send).toHaveBeenCalledWith('/api/tools/refresh', { method: 'POST' });
    expect(refresh).toHaveBeenCalled();
  });

  it('posts to the per-backend route with the backend id', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: { backendId: BACKEND, refreshed: true } });

    render(<ToolRefresh backendId={BACKEND} label="Rediscover backend" />);
    fireEvent.click(screen.getByRole('button', { name: 'Rediscover backend' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(`/api/backends/${BACKEND}/tools/refresh`, { method: 'POST' }));
  });

  it('reports per-backend failures as a partial result, naming each failure', async () => {
    send.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        refreshed: 1,
        failed: 1,
        results: [
          { backendId: BACKEND, ok: false, error: { code: 'BACKEND_CONNECTION_ERROR', message: 'Could not connect.' } },
        ],
      },
    });

    render(<ToolRefresh />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

    await waitFor(() => expect(screen.getByText(/Refreshed 1, failed 1/)).toBeTruthy());
    expect(screen.getByText(/Could not connect\./)).toBeTruthy();
    // The catalog was still refreshed, so the page is re-read.
    expect(refresh).toHaveBeenCalled();
  });

  it('surfaces a rejected request and does not claim success or refresh', async () => {
    send.mockResolvedValue({ ok: false, status: 503, message: 'Cannot reach the gateway.' });

    render(<ToolRefresh />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

    await waitFor(() => expect(screen.getByText('Cannot reach the gateway.')).toBeTruthy());
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

    render(<ToolRefresh />);
    const button = screen.getByRole('button', { name: 'Refresh catalog' });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);

    release?.({ ok: true, status: 200, data: { refreshed: 0, failed: 0, results: [] } });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('treats an unreadable global answer as a failure, not as zero backends', async () => {
    send.mockResolvedValue({ ok: true, status: 200, data: undefined });

    render(<ToolRefresh />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));

    await waitFor(() => expect(screen.getByText('The refresh answer could not be read.')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });
});
