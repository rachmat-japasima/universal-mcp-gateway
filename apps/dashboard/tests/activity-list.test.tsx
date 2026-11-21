import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { ActivityEvent, Page } from '@/lib/api/types';

/**
 * The activity list page.
 *
 * Claims pinned here:
 *
 *  * a failed read is an error state, never "no activity";
 *  * an empty table and a no-match filter say different things;
 *  * only the gateway's filters are forwarded, and an unknown enum value never is;
 *  * the tiles come from `/overview`, so they describe the whole table rather than
 *    the visible page — and `null` renders as Unavailable, not 0.
 */

const getActivity = vi.fn();
const getOverview = vi.fn();
const listAgents = vi.fn();
const listBackends = vi.fn();

vi.mock('@/lib/api/endpoints', () => ({
  getActivity: (...args: unknown[]) => getActivity(...args),
  getOverview: () => getOverview(),
}));
vi.mock('@/lib/api/agents', () => ({ listAgents: (...args: unknown[]) => listAgents(...args) }));
vi.mock('@/lib/api/backends', () => ({ listBackends: (...args: unknown[]) => listBackends(...args) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/activity',
}));

const { default: ActivityPage } = await import('@/app/(dashboard)/dashboard/activity/page');

const AGENT = '22222222-2222-4222-8222-222222222222';
const BACKEND = '11111111-1111-4111-8111-111111111111';
const EVENT = '99999999-9999-4999-8999-999999999999';

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: EVENT,
    type: 'tools.call',
    agentId: AGENT,
    backendId: BACKEND,
    toolName: 'read_file',
    outcome: 'success',
    durationMs: 4200,
    createdAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

function page(data: ActivityEvent[], overrides: Partial<Page<ActivityEvent>['pagination']> = {}): Page<ActivityEvent> {
  return { data, pagination: { page: 1, limit: 20, total: data.length, totalPages: 1, ...overrides } };
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await ActivityPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  for (const mock of [getActivity, getOverview, listAgents, listBackends]) mock.mockReset();
  getOverview.mockResolvedValue({
    activity: { total: 10, byType: { 'tools.call': 8, 'tools.list': 2 }, byOutcome: { success: 7, failure: 2, denied: 1 } },
  });
  listAgents.mockResolvedValue({ data: [{ id: AGENT, name: 'laptop' }], pagination: {} });
  listBackends.mockResolvedValue({ data: [{ id: BACKEND, name: 'filesystem' }], pagination: {} });
});

describe('activity list page', () => {
  it('renders the empty state and no fabricated row', async () => {
    getActivity.mockResolvedValue(page([]));
    getOverview.mockResolvedValue({ activity: { total: 0, byType: {}, byOutcome: {} } });

    await renderPage();

    expect(screen.getByText('No activity recorded')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('distinguishes no-match from empty', async () => {
    getActivity.mockResolvedValue(page([], { total: 0 }));

    await renderPage({ outcome: 'denied' });

    expect(screen.getByText('No activity matches these filters')).toBeTruthy();
    expect(screen.queryByText('No activity recorded')).toBeNull();
  });

  it('treats a failed read as an error state', async () => {
    getActivity.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('The activity list could not be read')).toBeTruthy();
    expect(screen.queryByText('No activity recorded')).toBeNull();
  });

  it('renders a row with its agent name, backend name, and duration', async () => {
    getActivity.mockResolvedValue(page([event()]));

    await renderPage();

    // Scoped to the table: the filter selects also contain the agent and backend
    // names as <option> text, and matching those would pass even if the row lost
    // its name lookup.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('laptop')).toBeTruthy();
    expect(table.getByText('filesystem')).toBeTruthy();
    expect(table.getByText('read_file')).toBeTruthy();
    expect(table.getByText('4s')).toBeTruthy();
    expect(table.getByRole('link', { name: /2026-11-21/ }).getAttribute('href')).toBe(
      `/dashboard/activity/${EVENT}`,
    );
  });

  it('says "Not recorded" for an event without a duration', async () => {
    getActivity.mockResolvedValue(page([event({ durationMs: undefined })]));

    await renderPage();

    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('forwards only the gateway filters and drops an unknown enum', async () => {
    getActivity.mockResolvedValue(page([]));

    await renderPage({ type: 'tools.call', outcome: 'bogus', agentId: AGENT, order: 'asc', limit: '200' });

    expect(getActivity).toHaveBeenCalledWith({ type: 'tools.call', agentId: AGENT, order: 'asc' });
  });

  it('shows Unavailable for a failed overview instead of zeros', async () => {
    getActivity.mockResolvedValue(page([event()]));
    getOverview.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getAllByText('Unavailable').length).toBe(4);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('labels the counts as whole-table figures, not page figures', async () => {
    getActivity.mockResolvedValue(page([event()], { total: 1 }));

    await renderPage({ type: 'tools.call' });

    // 10 recorded events overall, while only 1 row matched the filter.
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText(/1 matching event/)).toBeTruthy();
  });
});
