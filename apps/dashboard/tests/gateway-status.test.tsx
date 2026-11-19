import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayStatus } from '@/components/feedback/gateway-status';
import type { Readiness } from '@/lib/api/types';

/**
 * `GatewayStatus` refresh behaviour.
 *
 * The bug these tests exist for: `fetch` resolves for `503`, so a naive
 * `response.json() as Readiness` turns the proxy's error envelope into
 * "Gateway not ready" — reporting a gateway that is running-but-unhealthy when
 * in fact it is not running at all. Every non-2xx case below must land on
 * `unreachable`, which is the honest label.
 */

const ready: Readiness = {
  status: 'ready',
  checks: { database: 'ok', migrations: 'ok' },
  migrationVersion: '0005',
  timestamp: '2026-11-18T22:59:32.753Z',
};

const proxyErrorEnvelope = {
  error: {
    code: 'BACKEND_UNAVAILABLE',
    message: 'Cannot reach the gateway. Check that it is running, then retry.',
    requestId: 'dashboard-proxy',
  },
};

/** Replace `fetch` with one that returns a canned Response. */
function mockFetch(implementation: () => Promise<Response> | Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn(implementation);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders with the "not yet probed" server value, then clicks the control. */
async function clickRefresh(): Promise<void> {
  fireEvent.click(screen.getByRole('button'));
}

describe('GatewayStatus', () => {
  it('reports no readiness claim when the server probe was null', () => {
    render(<GatewayStatus initial={null} />);

    expect(screen.getByText('Gateway unreachable')).toBeDefined();
  });

  it('shows the server-rendered readiness result without fetching', () => {
    const spy = mockFetch(() => jsonResponse(ready));
    render(<GatewayStatus initial={ready} />);

    expect(screen.getByText('Gateway ready')).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts HTTP 200 with a valid readiness payload', async () => {
    mockFetch(() => jsonResponse(ready));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway ready')).toBeDefined());
  });

  it('treats HTTP 503 with the proxy error envelope as unreachable, not not_ready', async () => {
    mockFetch(() => jsonResponse(proxyErrorEnvelope, 503));
    render(<GatewayStatus initial={ready} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway unreachable')).toBeDefined());
    // The specific regression: an error envelope must never be read as a
    // readiness document, which would have rendered this instead.
    expect(screen.queryByText('Gateway not ready')).toBeNull();
  });

  it('treats HTTP 503 with a genuine not_ready payload as answered', async () => {
    // Both the proxy's "unreachable" and the gateway's "not ready" arrive as
    // 503 through the same route. Only the payload distinguishes them, so this
    // case would regress if status alone decided the outcome.
    const notReady: Readiness = {
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unavailable' },
      timestamp: '2026-11-18T22:59:32.753Z',
    };
    mockFetch(() => jsonResponse(notReady, 503));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway not ready')).toBeDefined());
    expect(screen.queryByText('Gateway unreachable')).toBeNull();
  });

  it('treats HTTP 500 as unreachable', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'x' } }, 500));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway unreachable')).toBeDefined());
  });

  it('treats a network failure as unreachable', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway unreachable')).toBeDefined());
  });

  it('treats malformed JSON on HTTP 200 as unreachable', async () => {
    mockFetch(() => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway unreachable')).toBeDefined());
  });

  it('treats a valid-JSON but wrong-structure body as unreachable', async () => {
    mockFetch(() => jsonResponse({ status: 'ok', timestamp: 'now' }));
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    await waitFor(() => expect(screen.getByText('Gateway unreachable')).toBeDefined());
  });

  it('refetches on Retry after a failure', async () => {
    const spy = mockFetch(() => jsonResponse(proxyErrorEnvelope, 503));
    render(<GatewayStatus initial={null} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // Second attempt succeeds — the control is wired to the same `refresh`.
    spy.mockImplementation(() => jsonResponse(ready));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Gateway ready')).toBeDefined());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('disables the control while a probe is in flight', async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    mockFetch(() => pending);
    render(<GatewayStatus initial={null} />);

    await clickRefresh();

    // In flight: no second request can be issued.
    await waitFor(() => expect(screen.getByText('Checking gateway')).toBeDefined());
    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true').toBe(true);

    release(jsonResponse(ready));
    await waitFor(() => expect(screen.getByText('Gateway ready')).toBeDefined());
  });
});
