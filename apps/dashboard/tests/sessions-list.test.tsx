import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { Agent, Page, Session } from '@/lib/api/types';

/**
 * The session list page.
 *
 * Claims pinned here:
 *
 *  * a failed read is an error state, never "no sessions";
 *  * an empty registry explains that no client has connected;
 *  * only the filters the gateway accepts are forwarded — there is no `search`;
 *  * an id lookup redirects to the detail route instead of inventing a list
 *    filter the API does not have;
 *  * the counts come from `/overview`, so a filtered page does not report its own
 *    row count as the registry total.
 */

const listSessions = vi.fn();
const getOverview = vi.fn();
const listAgents = vi.fn();
const redirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});

vi.mock('@/lib/api/sessions', () => ({ listSessions: (...args: unknown[]) => listSessions(...args) }));
vi.mock('@/lib/api/endpoints', () => ({ getOverview: () => getOverview() }));
vi.mock('@/lib/api/agents', () => ({ listAgents: (...args: unknown[]) => listAgents(...args) }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirect(path),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/sessions',
}));

const { default: SessionsPage } = await import('@/app/(dashboard)/dashboard/sessions/page');

const SESSION = '99999999-9999-4999-8999-999999999999';
const AGENT = '22222222-2222-4222-8222-222222222222';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    agentId: AGENT,
    status: 'active',
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActivityAt: '2026-11-20T10:05:00.000Z',
    ...overrides,
  };
}

function page(data: Session[], overrides: Partial<Page<Session>['pagination']> = {}): Page<Session> {
  return {
    data,
    pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length === 0 ? 0 : 1, ...overrides },
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: 'claude-code-laptop',
    enabled: true,
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

const counts = { active: 2, expired: 1, terminated: 3, invalidated: 0 };

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await SessionsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  for (const mock of [listSessions, getOverview, listAgents, redirect]) mock.mockReset();
  getOverview.mockResolvedValue({ sessions: counts });
  listAgents.mockResolvedValue({ data: [agent()], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } });
  redirect.mockImplementation((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
});

describe('session list page', () => {
  it('renders the empty state and no fabricated row', async () => {
    listSessions.mockResolvedValue(page([]));
    getOverview.mockResolvedValue({ sessions: { active: 0, expired: 0, terminated: 0, invalidated: 0 } });

    await renderPage();

    expect(screen.getByText('No sessions recorded')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('treats a failed read as an error state, not an empty history', async () => {
    listSessions.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.queryByText('No sessions recorded')).toBeNull();
    expect(screen.getByText('The session list could not be read')).toBeTruthy();
  });

  it('renders rows linking to the detail page with the agent name and status', async () => {
    listSessions.mockResolvedValue(page([session()]));

    await renderPage();

    const link = screen.getByRole('link', { name: SESSION });
    expect(link.getAttribute('href')).toBe(`/dashboard/sessions/${SESSION}`);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-code-laptop').length).toBeGreaterThan(0);
  });

  it('shows registry-wide counts on a filtered page', async () => {
    listSessions.mockResolvedValue(page([session()], { total: 1 }));

    await renderPage({ status: 'active' });

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('degrades the agent label to the id when the agent read fails', async () => {
    listSessions.mockResolvedValue(page([session()]));
    listAgents.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByRole('link', { name: SESSION })).toBeTruthy();
    expect(screen.getAllByText(`Agent ${AGENT}`).length).toBeGreaterThan(0);
  });

  it('forwards only the filters the gateway accepts', async () => {
    listSessions.mockResolvedValue(page([]));

    await renderPage({ agentId: AGENT, status: 'terminated', sort: 'lastActivityAt', order: 'asc', page: '2' });

    expect(listSessions).toHaveBeenCalledWith({
      agentId: AGENT,
      status: 'terminated',
      sort: 'lastActivityAt',
      order: 'asc',
      page: 2,
    });
  });

  it('drops a status the gateway does not define rather than forwarding it', async () => {
    listSessions.mockResolvedValue(page([]));

    await renderPage({ status: 'paused', agentId: 'not-a-uuid' });

    expect(listSessions).toHaveBeenCalledWith({});
  });

  it('redirects an id lookup to the real detail route', async () => {
    await expect(renderPage({ sessionId: SESSION })).rejects.toThrow(`REDIRECT:/dashboard/sessions/${SESSION}`);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('explains a malformed id instead of asking the gateway a 400 question', async () => {
    listSessions.mockResolvedValue(page([]));

    await renderPage({ sessionId: 'proto-123' });

    expect(screen.getByText(/is not a session id/)).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    // The list is still shown.
    expect(listSessions).toHaveBeenCalled();
  });
});
