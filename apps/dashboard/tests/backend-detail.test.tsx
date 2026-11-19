import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { Backend, BackendRuntimeView } from '@/lib/api/types';

/**
 * The backend detail page.
 *
 * Two claims are load-bearing here:
 *
 *  * **A failed runtime read does not hide the configuration.** The page reports
 *    the failure in the runtime section and still shows what the gateway *did*
 *    return. Substituting an empty runtime would be the "0 means the read
 *    failed" lie the API's `null` semantics exist to prevent.
 *  * **There is no secret to redact.** `env`/`headers` values are references by
 *    contract, so the test asserts the reference is displayed verbatim — if a
 *    literal value ever appeared in the payload, that would be a gateway bug and
 *    the dashboard would show it rather than silently mask something it does not
 *    understand.
 */

const getBackend = vi.fn();
const getBackendRuntime = vi.fn();
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/api/backends', () => ({
  getBackend: (...args: unknown[]) => getBackend(...args),
  getBackendRuntime: (...args: unknown[]) => getBackendRuntime(...args),
}));

const { default: BackendDetailPage } = await import('@/app/(dashboard)/dashboard/backends/[backendId]/page');

const ID = '11111111-1111-4111-8111-111111111111';

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    id: ID,
    name: 'filesystem',
    description: 'Local file access',
    transport: 'stdio',
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      cwd: '/srv',
      env: { TOKEN: 'secret:fs/token', REGION: 'env:AWS_REGION' },
    },
    enabled: true,
    timeoutMs: 15000,
    concurrencyMode: 'limited',
    concurrencyLimit: 2,
    version: 7,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T02:00:00.000Z',
    ...overrides,
  };
}

function runtime(overrides: Partial<BackendRuntimeView> = {}): BackendRuntimeView {
  return {
    backendId: ID,
    status: 'connected',
    lastConnectedAt: '2026-11-19T01:00:00.000Z',
    lastHealthCheckAt: '2026-11-19T01:05:00.000Z',
    reconnectAttempts: 3,
    updatedAt: '2026-11-19T01:05:00.000Z',
    ...overrides,
  };
}

async function renderPage(): Promise<void> {
  render(await BackendDetailPage({ params: Promise.resolve({ backendId: ID }) }));
}

beforeEach(() => {
  getBackend.mockReset();
  getBackendRuntime.mockReset();
  notFound.mockClear();
});

describe('backend detail page', () => {
  it('renders the saved configuration, including argument boundaries', async () => {
    getBackend.mockResolvedValue(backend());
    getBackendRuntime.mockResolvedValue(runtime());

    await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'filesystem' })).toBeTruthy();
    expect(screen.getByText('Local file access')).toBeTruthy();
    expect(screen.getByText('npx')).toBeTruthy();
    expect(screen.getByText('-y')).toBeTruthy();
    // The path with a leading slash is one argument, not a fragment of a shell string.
    expect(screen.getByText('@modelcontextprotocol/server-filesystem')).toBeTruthy();
    expect(screen.getByText('/tmp')).toBeTruthy();
    expect(screen.getByText('15000 ms')).toBeTruthy();
    expect(screen.getAllByText('limited').length).toBeGreaterThan(0);
  });

  it('shows secret references as references and never invents a masked value', async () => {
    getBackend.mockResolvedValue(backend());
    getBackendRuntime.mockResolvedValue(runtime());

    await renderPage();

    expect(screen.getByText('secret:fs/token')).toBeTruthy();
    expect(screen.getByText('env:AWS_REGION')).toBeTruthy();
    expect(screen.getByText('TOKEN')).toBeTruthy();
    expect(screen.getByText('REGION')).toBeTruthy();
    // No placeholder of the kind a redacting UI would render.
    expect(screen.queryByText(/\*{4,}/)).toBeNull();
  });

  it('renders the lifecycle fields the list view does not carry', async () => {
    getBackend.mockResolvedValue(backend());
    getBackendRuntime.mockResolvedValue(runtime());

    await renderPage();

    // `reconnectAttempts` is the wire field name; the type once said `attempts`.
    expect(screen.getByText('Reconnect attempts')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Last connected')).toBeTruthy();
    expect(screen.getByText('Last health check')).toBeTruthy();
  });

  it('reports a last error when the runtime recorded one', async () => {
    getBackend.mockResolvedValue(backend());
    getBackendRuntime.mockResolvedValue(
      runtime({
        status: 'error',
        lastErrorCode: 'BACKEND_CONNECTION_FAILED',
        lastErrorAt: '2026-11-19T01:10:00.000Z',
        lastErrorMessage: 'The server closed the connection during initialization.',
      }),
    );

    await renderPage();

    expect(screen.getByText('BACKEND_CONNECTION_FAILED')).toBeTruthy();
    expect(screen.getByText('The server closed the connection during initialization.')).toBeTruthy();
  });

  it('keeps the configuration when the runtime read fails, and says so', async () => {
    getBackend.mockResolvedValue(backend());
    getBackendRuntime.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    // Configuration is still current.
    expect(screen.getByText('npx')).toBeTruthy();
    expect(screen.getByText('secret:fs/token')).toBeTruthy();
    expect(screen.queryByText('Reconnect attempts')).toBeNull();
    expect(screen.getByText(/only the live state could not be read/)).toBeTruthy();
  });

  it('does not present the reduced list status as live when the runtime read failed', async () => {
    getBackend.mockResolvedValue(backend({ runtime: { status: 'disconnected', updatedAt: '2026-11-19T02:00:00.000Z' } }));
    getBackendRuntime.mockRejectedValue(new ApiError('http', 'The gateway rejected the request (HTTP 404).', { status: 404 }));

    await renderPage();

    // The configuration read still carries `runtime.disconnected`, but it is not
    // current, so the Overview row says so instead of repeating it as fact.
    expect(screen.getByText('Unavailable — see Runtime')).toBeTruthy();
    expect(screen.queryByText('Disconnected')).toBeNull();
  });

  it('renders the http transport fields for a streamable-http backend', async () => {
    getBackend.mockResolvedValue(
      backend({
        transport: 'streamable-http',
        connection: { type: 'streamable-http', url: 'https://mcp.example.test/sse', headers: { authorization: 'secret:mcp/token' } },
      }),
    );
    getBackendRuntime.mockResolvedValue(runtime({ status: 'disconnected', reconnectAttempts: 0 }));

    await renderPage();

    expect(screen.getByText('https://mcp.example.test/sse')).toBeTruthy();
    expect(screen.getByText('secret:mcp/token')).toBeTruthy();
    expect(screen.queryByText('Executable')).toBeNull();
  });

  it('is not found when the gateway says the backend does not exist', async () => {
    getBackend.mockRejectedValue(
      new ApiError('http', 'The requested backend does not exist.', { status: 404, code: 'RESOURCE_NOT_FOUND' }),
    );

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders an error state, not a not-found, for a gateway that cannot be reached', async () => {
    getBackend.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByText('The backend could not be read')).toBeTruthy();
    expect(screen.getByText(/Cannot reach the gateway/)).toBeTruthy();
  });
});
