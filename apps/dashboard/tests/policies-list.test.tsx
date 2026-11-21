import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Page, Policy } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * The policy list page.
 *
 * Claims pinned here:
 *
 *  * a failed read is an error state, never "0 policies" — the difference
 *    matters under default-deny;
 *  * an empty registry explains the baseline instead of showing a bare table;
 *  * the tile figures are labelled as describing the visible page, because the
 *    API exposes no registry-wide policy counts;
 *  * only `search` and `effect` are forwarded; anything else would earn a `400`.
 */

const listPolicies = vi.fn();

vi.mock('@/lib/api/policies', () => ({ listPolicies: (...args: unknown[]) => listPolicies(...args) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/policies',
}));

const { default: PoliciesPage } = await import('@/app/(dashboard)/dashboard/policies/page');

const POLICY = '77777777-7777-4777-8777-777777777777';
const BACKEND = '11111111-1111-4111-8111-111111111111';

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: POLICY,
    name: 'read-only',
    description: 'Read tools only',
    priority: 10,
    rules: [
      { resource: 'backend', target: BACKEND, effect: 'allow' },
      { resource: 'tool', target: 'github__delete', effect: 'deny' },
    ],
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function page(data: Policy[], overrides: Partial<Page<Policy>['pagination']> = {}): Page<Policy> {
  return {
    data,
    pagination: { page: 1, limit: 20, total: data.length, totalPages: data.length === 0 ? 0 : 1, ...overrides },
  };
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await PoliciesPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  listPolicies.mockReset();
});

describe('policy list page', () => {
  it('renders the empty state with a create action and explains default-deny', async () => {
    listPolicies.mockResolvedValue(page([]));

    await renderPage();

    expect(screen.getByText('No access policies')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Create policy' });
    expect(links[0]!.getAttribute('href')).toBe('/dashboard/policies/new');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('treats a failed read as an error state, not an empty registry', async () => {
    listPolicies.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.queryByText('No access policies')).toBeNull();
    expect(screen.getByText('The policy registry could not be read')).toBeTruthy();
  });

  it('renders rows linking to the detail page, with priority and a rule summary', async () => {
    listPolicies.mockResolvedValue(page([policy()]));

    await renderPage();

    const link = screen.getByRole('link', { name: 'read-only' });
    expect(link.getAttribute('href')).toBe(`/dashboard/policies/${POLICY}`);
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('1 allow')).toBeTruthy();
    expect(screen.getByText('1 deny')).toBeTruthy();
  });

  it('says the tiles describe the page, because there is no registry-wide count', async () => {
    listPolicies.mockResolvedValue(page([policy()], { total: 40, totalPages: 2 }));

    await renderPage({ search: 'read' });

    expect(screen.getByText(/Allow rules on this page of 40/)).toBeTruthy();
    expect(screen.getByText(/Deny rules on this page of 40/)).toBeTruthy();
  });

  it('counts wildcard allows separately from ordinary allows', async () => {
    listPolicies.mockResolvedValue(
      page([policy({ rules: [{ resource: 'tool', target: '*', effect: 'allow' }] })]),
    );

    await renderPage();

    // Three tiles: 1 allow, 0 deny, 1 thereof a wildcard. The allow count is
    // rendered twice on purpose, so only the wildcard tile is asserted by value.
    expect(screen.getByText(/Wildcard allows/)).toBeTruthy();
    expect(screen.getAllByText('1').length).toBe(2);
  });

  it('passes only the filters the gateway accepts', async () => {
    listPolicies.mockResolvedValue(page([]));

    await renderPage({ search: '  read  ', effect: 'deny', page: '2', agentId: 'ignored' });

    expect(listPolicies).toHaveBeenCalledWith({ search: 'read', effect: 'deny', page: 2 });
  });

  it('drops an effect value the gateway would reject', async () => {
    listPolicies.mockResolvedValue(page([]));

    await renderPage({ effect: 'maybe', page: 'nope' });

    expect(listPolicies).toHaveBeenCalledWith({});
  });

  it('offers a real GET form with the documented filters', async () => {
    listPolicies.mockResolvedValue(page([policy()]));

    await renderPage();

    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/dashboard/policies');
    expect(form.getAttribute('method')).toBe('get');
    expect((within(form).getByLabelText('Contains rule') as HTMLSelectElement).value).toBe('');
    expect(within(form).getByLabelText('Search')).toBeTruthy();
  });

  it('distinguishes a filtered miss from an empty registry', async () => {
    listPolicies.mockResolvedValue(page([], { total: 0, totalPages: 0 }));

    await renderPage({ search: 'nothing' });

    expect(screen.getByText('No policies match these filters')).toBeTruthy();
    expect(screen.queryByText('No access policies')).toBeNull();
  });
});
