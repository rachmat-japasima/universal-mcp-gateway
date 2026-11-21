import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentCounts, Page } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * The agent registry page.
 *
 * The claims pinned here:
 *
 *  * a failed read is an error state, never "0 agents";
 *  * an empty registry says so and offers the create action, with no invented row;
 *  * counts come from `/overview`, so a filtered page cannot understate the
 *    registry (and `/monitoring` does not report agents at all);
 *  * the filters are the gateway's three and unsupported values are dropped
 *    rather than forwarded to earn a `400`.
 */

const listAgents = vi.fn();
const getOverview = vi.fn();
const getMonitoring = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/agents',
}));

vi.mock('@/lib/api/agents', () => ({ listAgents: (...args: unknown[]) => listAgents(...args) }));
vi.mock('@/lib/api/endpoints', () => ({
  getOverview: (...args: unknown[]) => getOverview(...args),
  getMonitoring: (...args: unknown[]) => getMonitoring(...args),
}));

const { default: AgentsPage } = await import('@/app/(dashboard)/dashboard/agents/page');

const AGENT = '22222222-2222-4222-8222-222222222222';

const counts: AgentCounts = { total: 5, enabled: 3, disabled: 2 };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: 'claude-code-laptop',
    description: 'Operator workstation',
    clientType: 'claude-code',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function page(data: Agent[], overrides: Partial<Page<Agent>['pagination']> = {}): Page<Agent> {
  return {
    data,
    pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length === 0 ? 0 : 1, ...overrides },
  };
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await AgentsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  for (const mock of [listAgents, getOverview, getMonitoring]) mock.mockReset();
  getOverview.mockResolvedValue({ agents: counts });
});

describe('agent list page', () => {
  it('renders the empty state with a create action and no fabricated row', async () => {
    listAgents.mockResolvedValue(page([]));
    getOverview.mockResolvedValue({ agents: { total: 0, enabled: 0, disabled: 0 } });

    await renderPage();

    expect(screen.getByText('No agents registered')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Add agent' });
    expect(links[0]!.getAttribute('href')).toBe('/dashboard/agents/new');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('treats a failed read as an error state, not an empty registry', async () => {
    listAgents.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.queryByText('No agents registered')).toBeNull();
    expect(screen.getByText('The agent registry could not be read')).toBeTruthy();
  });

  it('renders real rows linking to the detail page, with status and client type', async () => {
    listAgents.mockResolvedValue(page([agent(), agent({ id: 'x', name: 'second', enabled: false, status: 'disabled', clientType: undefined })]));

    await renderPage();

    const link = screen.getByRole('link', { name: 'claude-code-laptop' });
    expect(link.getAttribute('href')).toBe(`/dashboard/agents/${AGENT}`);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    // An unset client type is absence, not "Other".
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('shows registry-wide counts even when the table is one filtered page', async () => {
    listAgents.mockResolvedValue(page([agent()], { total: 1, totalPages: 1 }));

    await renderPage({ search: 'laptop' });

    expect(screen.getAllByText('Agents').length).toBeGreaterThan(0);
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('degrades the count tiles without failing the table', async () => {
    listAgents.mockResolvedValue(page([agent()]));
    getOverview.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByRole('link', { name: 'claude-code-laptop' })).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('passes only the filters the gateway accepts', async () => {
    listAgents.mockResolvedValue(page([]));

    await renderPage({ search: '  laptop  ', status: 'disabled', clientType: ' codex-cli ', page: '2' });

    expect(listAgents).toHaveBeenCalledWith({
      search: 'laptop',
      status: 'disabled',
      clientType: 'codex-cli',
      page: 2,
    });
  });

  it('drops values the gateway would reject', async () => {
    listAgents.mockResolvedValue(page([]));

    await renderPage({ status: 'paused', page: 'abc' });

    expect(listAgents).toHaveBeenCalledWith({});
  });

  it('offers a real GET form with the three documented filters', async () => {
    listAgents.mockResolvedValue(page([agent()]));

    await renderPage();

    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/dashboard/agents');
    expect(form.getAttribute('method')).toBe('get');
    expect((within(form).getByLabelText('Search') as HTMLInputElement).value).toBe('');
    expect(within(form).getByLabelText('Status')).toBeTruthy();
    expect(within(form).getByLabelText('Client type')).toBeTruthy();
  });
});
