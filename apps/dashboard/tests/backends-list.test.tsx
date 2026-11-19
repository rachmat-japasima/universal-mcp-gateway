import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Backend, BackendCounts, Page } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * The registry page, rendered against a stubbed API.
 *
 * These are the cases where a dashboard would lie if it were careless:
 *
 *  * a failed read must be an error state, never "0 backends";
 *  * an empty registry must say so with an add action, and must not invent a row;
 *  * counts come from `monitoring/backends`, so they describe the whole registry
 *    even when the table is showing one filtered page;
 *  * a failed counts read degrades the tiles, not the table.
 */

const listBackends = vi.fn();
const getMonitoringBackends = vi.fn();

// `BackendActions` is a client component inside each row and calls `useRouter`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/backends',
}));

vi.mock('@/lib/api/backends', () => ({ listBackends: (...args: unknown[]) => listBackends(...args) }));
vi.mock('@/lib/api/endpoints', () => ({
  getMonitoringBackends: (...args: unknown[]) => getMonitoringBackends(...args),
}));

const { default: BackendsPage } = await import('@/app/(dashboard)/dashboard/backends/page');

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'filesystem',
    description: 'Local file access',
    transport: 'stdio',
    connection: { type: 'stdio', command: 'npx', args: [], env: {} },
    enabled: true,
    timeoutMs: 30000,
    concurrencyMode: 'serialized',
    version: 2,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T01:02:03.000Z',
    runtime: { status: 'connected', updatedAt: '2026-11-19T01:02:03.000Z' },
    ...overrides,
  };
}

function page(data: Backend[], overrides: Partial<Page<Backend>['pagination']> = {}): Page<Backend> {
  return {
    data,
    pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length === 0 ? 0 : 1, ...overrides },
  };
}

const counts: BackendCounts = {
  total: 9,
  enabled: 6,
  disabled: 3,
  runtime: {
    disconnected: 4,
    connecting: 0,
    connected: 1,
    unhealthy: 3,
    disconnecting: 0,
    error: 5,
    disabled: 0,
  },
};

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await BackendsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  listBackends.mockReset();
  getMonitoringBackends.mockReset();
});

describe('backend list page', () => {
  it('renders the empty state with an add action and no fabricated row', async () => {
    listBackends.mockResolvedValue(page([]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage();

    expect(screen.getByText('No backends registered')).toBeTruthy();
    // Two add affordances by design: the header action and the empty-state action.
    const adds = screen.getAllByRole('link', { name: 'Add Backend' });
    expect(adds.length).toBe(2);
    for (const add of adds) expect(add.getAttribute('href')).toBe('/dashboard/backends/new');
    // The counts are real (the registry read succeeded), so they render as 9.
    expect(screen.getByText('Total backends')).toBeTruthy();
    expect(screen.getAllByText('9').length).toBeGreaterThan(0);
  });

  it('treats a failed read as an error state, not an empty list', async () => {
    listBackends.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));
    getMonitoringBackends.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.queryByText('No backends registered')).toBeNull();
    expect(screen.getByText('The backend registry could not be read')).toBeTruthy();
    expect(screen.getByText(/Cannot reach the gateway/)).toBeTruthy();
  });

  it('renders real rows with transport, enabled state, and runtime status', async () => {
    listBackends.mockResolvedValue(page([backend(), backend({ id: '22222222-2222-4222-8222-222222222222', name: 'remote', transport: 'streamable-http', enabled: false, runtime: { status: 'error', updatedAt: '2026-11-19T01:00:00.000Z' }, connection: { type: 'streamable-http', url: 'https://mcp.test', headers: {} } })]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage();

    expect(screen.getByRole('link', { name: 'filesystem' }).getAttribute('href')).toBe(
      '/dashboard/backends/11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getAllByText('Local file access').length).toBeGreaterThan(0);
    expect(screen.getAllByText('STDIO').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Streamable HTTP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Error').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  it('shows counts from monitoring even when the table is one filtered page', async () => {
    listBackends.mockResolvedValue(page([backend()], { total: 1, totalPages: 1 }));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ search: 'file' });

    // The table says one backend; the tiles still describe the registry.
    expect(screen.getByText('Total backends')).toBeTruthy();
    expect(screen.getByText('Error or unhealthy')).toBeTruthy();
    // error(5) + unhealthy(3) = 8, rendered in the fourth tile.
    const tile = screen.getByText('Error or unhealthy').closest('div')!.parentElement!.parentElement!;
    expect(tile.textContent).toContain('8');
  });

  it('passes only the filters the gateway accepts', async () => {
    listBackends.mockResolvedValue(page([]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ search: '  file  ', transport: 'stdio', enabled: 'false', page: '3', sort: 'createdAt' });

    expect(listBackends).toHaveBeenCalledWith({ search: 'file', transport: 'stdio', enabled: false, page: 3 });
  });

  it('ignores values the gateway would reject rather than forwarding them', async () => {
    listBackends.mockResolvedValue(page([]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ transport: 'carrier-pigeon', enabled: 'maybe', page: 'abc' });

    expect(listBackends).toHaveBeenCalledWith({});
  });

  it('offers the filters as a real GET form, so the query survives a reload', async () => {
    listBackends.mockResolvedValue(page([backend()]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ search: 'file' });

    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/dashboard/backends');
    expect(form.getAttribute('method')).toBe('get');
    expect((within(form).getByLabelText('Search') as HTMLInputElement).value).toBe('file');
    expect(within(form).getByRole('button', { name: 'Apply filters' })).toBeTruthy();
    // Runtime filtering is documented as unsupported, not silently offered.
    expect(within(form).queryByLabelText('Runtime')).toBeNull();
  });

  it('degrades the counts to Unavailable when monitoring fails, keeping the table', async () => {
    listBackends.mockResolvedValue(page([backend()]));
    getMonitoringBackends.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('filesystem')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('paginates using the gateway pagination, linking to the next page', async () => {
    listBackends.mockResolvedValue(page([backend()], { total: 45, totalPages: 3, page: 1 }));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ search: 'file' });

    expect(screen.getByText(/page 1 of 3/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe('/dashboard/backends?search=file&page=2');
  });

  it('says no backends match instead of claiming the registry is empty', async () => {
    listBackends.mockResolvedValue(page([]));
    getMonitoringBackends.mockResolvedValue({ counts, runtimes: [], discovery: [], conflicts: [] });

    await renderPage({ search: 'nothing' });

    expect(screen.getByText('No backends match these filters')).toBeTruthy();
    expect(screen.queryByText('No backends registered')).toBeNull();
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe('/dashboard/backends');
  });
});
