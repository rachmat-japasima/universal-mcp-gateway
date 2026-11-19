import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ErrorState } from '@/components/feedback/states';
import { ApiError } from '@/lib/api/errors';

/**
 * `ErrorState` is rendered from server components, so its retry affordance
 * cannot be an `onRetry` callback — a function prop cannot cross the RSC
 * boundary. It had been written that way, which meant no caller could ever pass
 * one and the button never rendered. These tests pin the replacement: a real
 * button that invokes `router.refresh()`.
 */

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

function renderErrorState(error: unknown): void {
  render(<ErrorState error={error} title="Could not read the overview" />);
}

describe('ErrorState', () => {
  it('renders an actionable Retry button for a reachable-but-failing read', () => {
    renderErrorState(new ApiError('unavailable', 'The gateway is not reachable.'));

    expect(screen.getByText('Could not read the overview')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('re-runs the server render when Retry is clicked', () => {
    refresh.mockClear();
    renderErrorState(new ApiError('timeout', 'The request timed out.'));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders the operator-facing message and request id, never a stack trace', () => {
    const error = new ApiError('http', 'The gateway rejected the request (HTTP 400).', {
      status: 400,
      code: 'VALIDATION_ERROR',
      requestId: 'req-123',
    });
    renderErrorState(error);

    expect(screen.getByText(/The gateway rejected the request \(HTTP 400\)\. \(request req-123\)/)).toBeDefined();
  });

  it('offers no retry for a contract mismatch, which would fail identically', () => {
    renderErrorState(new ApiError('invalid-response', 'Response did not contain a data envelope.'));

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('does not leak an unknown thrown value into the UI', () => {
    renderErrorState(new Error('SQLITE_ERROR: no such table: backends'));

    expect(screen.getByText('An unexpected error occurred.')).toBeDefined();
    expect(screen.queryByText(/SQLITE_ERROR/)).toBeNull();
  });
});
