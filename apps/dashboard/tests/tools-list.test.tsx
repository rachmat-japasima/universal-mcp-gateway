import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveryReport, Page, Tool, ToolCounts, ToolConflict } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * The tool explorer page, rendered against a stubbed API.
 *
 * The claims pinned here:
 *
 *  * a failed catalog read is an error state, never "0 tools";
 *  * an empty catalog says so and points at backends, not at a fabricated row;
 *  * counts come from `/monitoring` so they describe the whole catalog, not the
 *    one filtered page on screen;
 *  * a failed discovery/conflict read degrades its own section only;
 *  * the filters are the gateway's three, and unsupported values are dropped
 *    rather than forwarded to earn a `400`.
 */

const listTools = vi.fn();
const listBackends = vi.fn();
const getMonitoring = vi.fn();
const getDiscoveryReports = vi.fn();
const getToolConflicts = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/tools',
}));

vi.mock('@/lib/api/tools', () => ({
  listTools: (...args: unknown[]) => listTools(...args),
  getDiscoveryReports: (...args: unknown[]) => getDiscoveryReports(...args),
  getToolConflicts: (...args: unknown[]) => getToolConflicts(...args),
}));
vi.mock('@/lib/api/backends', () => ({ listBackends: (...args: unknown[]) => listBackends(...args) }));
vi.mock('@/lib/api/endpoints', () => ({ getMonitoring: (...args: unknown[]) => getMonitoring(...args) }));

const { default: ToolsPage } = await import('@/app/(dashboard)/dashboard/tools/page');

const BACKEND = '11111111-1111-4111-8111-111111111111';

const counts: ToolCounts = {
  total: 7,
  available: 4,
  unavailable: 2,
  conflict: 1,
  backendsWithCatalog: 2,
  discoveryFailures: 1,
};

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    publicName: `${BACKEND}__read_file`,
    originalName: 'read_file',
    backendId: BACKEND,
    description: 'Read one file',
    inputSchema: { type: 'object' },
    availability: 'available',
    discoveredAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T01:00:00.000Z',
    ...overrides,
  };
}

function page(data: Tool[], overrides: Partial<Page<Tool>['pagination']> = {}): Page<Tool> {
  return {
    data,
    pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length === 0 ? 0 : 1, ...overrides },
  };
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await ToolsPage({ searchParams: Promise.resolve(search) }));
}

const backend = { id: BACKEND, name: 'filesystem' };

beforeEach(() => {
  for (const mock of [listTools, listBackends, getMonitoring, getDiscoveryReports, getToolConflicts]) mock.mockReset();

  listBackends.mockResolvedValue({
    data: [
      {
        id: BACKEND,
        name: 'filesystem',
        transport: 'stdio',
        connection: { type: 'stdio', command: 'npx', args: [], env: {} },
        enabled: true,
        timeoutMs: 30000,
        concurrencyMode: 'serialized',
        version: 1,
        createdAt: '2026-11-19T00:00:00.000Z',
        updatedAt: '2026-11-19T00:00:00.000Z',
      },
    ],
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
  });
  getMonitoring.mockResolvedValue({ tools: counts });
  getDiscoveryReports.mockResolvedValue([]);
  getToolConflicts.mockResolvedValue([]);
});

describe('tools list page', () => {
  it('renders the empty state with a link to backends and no fabricated row', async () => {
    listTools.mockResolvedValue(page([]));
    getMonitoring.mockResolvedValue({ tools: { ...counts, total: 0, available: 0, unavailable: 0, conflict: 0 } });

    await renderPage();

    expect(screen.getByText('No tools discovered')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'View backends' })[0]!.getAttribute('href')).toBe('/dashboard/backends');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('treats a failed catalog read as an error state, not an empty catalog', async () => {
    listTools.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.queryByText('No tools discovered')).toBeNull();
    expect(screen.getByText('The tool catalog could not be read')).toBeTruthy();
    expect(screen.getByText(/Cannot reach the gateway/)).toBeTruthy();
  });

  it('renders real rows with backend name and availability wording', async () => {
    listTools.mockResolvedValue(
      page([
        tool(),
        tool({ publicName: `${BACKEND}__write_file`, originalName: 'write_file', availability: 'unavailable' }),
        tool({ publicName: `${BACKEND}__dup`, originalName: 'dup', availability: 'conflict' }),
      ]),
    );

    await renderPage();

    expect(screen.getByRole('link', { name: `${BACKEND}__read_file` }).getAttribute('href')).toBe(
      `/dashboard/tools/${encodeURIComponent(`${BACKEND}__read_file`)}`,
    );
    expect(screen.getAllByText('filesystem').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Name conflict').length).toBeGreaterThan(0);
  });

  it('shows whole-catalog counts even when the table is one filtered page', async () => {
    listTools.mockResolvedValue(page([tool()], { total: 1, totalPages: 1 }));

    await renderPage({ search: 'read' });

    expect(screen.getByText('Known tools')).toBeTruthy();
    // 7 total, 4 available, withheld = 2 + 1.
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getByText('Withheld')).toBeTruthy();
  });

  it('passes only the filters the gateway accepts', async () => {
    listTools.mockResolvedValue(page([]));

    await renderPage({ search: '  read  ', backendId: BACKEND, availability: 'conflict', page: '3' });

    expect(listTools).toHaveBeenCalledWith({
      search: 'read',
      backendId: BACKEND,
      availability: 'conflict',
      page: 3,
    });
  });

  it('drops values the gateway would reject instead of forwarding them', async () => {
    listTools.mockResolvedValue(page([]));

    await renderPage({ availability: 'maybe', page: 'abc' });

    expect(listTools).toHaveBeenCalledWith({});
  });

  it('offers the three documented filters as a real GET form', async () => {
    listTools.mockResolvedValue(page([tool()]));

    await renderPage({ search: 'read' });

    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/dashboard/tools');
    expect(form.getAttribute('method')).toBe('get');
    expect((within(form).getByLabelText('Search') as HTMLInputElement).value).toBe('read');
    expect(within(form).getByLabelText('Backend')).toBeTruthy();
    expect(within(form).getByLabelText('Availability')).toBeTruthy();
    // Agent access is a policy question with no catalog parameter, so it is not
    // offered as a filter that would quietly filter nothing.
    expect(within(form).queryByLabelText('Access')).toBeNull();
  });

  it('degrades the discovery and conflict sections without failing the table', async () => {
    listTools.mockResolvedValue(page([tool()]));
    getDiscoveryReports.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));
    getToolConflicts.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByRole('link', { name: `${BACKEND}__read_file` })).toBeTruthy();
    expect(screen.getByText('Discovery reports could not be read.')).toBeTruthy();
    expect(screen.getByText(/conflict list could not be read/)).toBeTruthy();
  });

  it('lists conflicts with their claimants and says they are withheld', async () => {
    listTools.mockResolvedValue(page([]));
    const conflicts: ToolConflict[] = [
      { publicName: `${BACKEND}__dup`, claimants: [{ backendId: BACKEND, originalName: 'dup' }] },
    ];
    getToolConflicts.mockResolvedValue(conflicts);

    await renderPage();

    expect(screen.getByText(`${BACKEND}__dup`)).toBeTruthy();
    expect(screen.getByText(/dup · filesystem/)).toBeTruthy();
  });

  it('reports discovery state per backend, with never as absence not failure', async () => {
    listTools.mockResolvedValue(page([]));
    const reports: DiscoveryReport[] = [
      {
        backendId: BACKEND,
        status: 'never',
        toolCount: 0,
        conflictCount: 0,
        rejectedCount: 0,
        discoveredAt: '2026-11-19T00:00:00.000Z',
      },
    ];
    getDiscoveryReports.mockResolvedValue(reports);

    await renderPage();

    expect(screen.getByText(/Never discovered/)).toBeTruthy();
  });

  it('renders "Unavailable" tiles rather than zeros when monitoring fails', async () => {
    listTools.mockResolvedValue(page([]));
    getMonitoring.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('includes the backend filter option list from the registry read', async () => {
    listTools.mockResolvedValue(page([tool()]));

    await renderPage();

    const form = screen.getByRole('search');
    const option = within(form).getByRole('option', { name: 'filesystem' }) as HTMLOptionElement;
    expect(option.value).toBe(backend.id);
  });
});
