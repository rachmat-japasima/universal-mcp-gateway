import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { AuditEvent, Page } from '@/lib/api/types';

/**
 * The audit trail page.
 *
 * Claims pinned here:
 *
 *  * audit is its own page with its own filters — it is not the activity table;
 *  * a failed read is an error, an empty trail is not "no changes ever";
 *  * `metadata` is never rendered from a list row (the payload omits it), and no
 *    edit/delete control exists anywhere;
 *  * the export link carries the same filters the table was read with.
 */

const getAudit = vi.fn();

vi.mock('@/lib/api/endpoints', () => ({ getAudit: (...args: unknown[]) => getAudit(...args) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/audit',
}));

const { default: AuditPage } = await import('@/app/(dashboard)/dashboard/audit/page');

const TARGET = '77777777-7777-4777-8777-777777777777';
const EVENT = '99999999-9999-4999-8999-999999999999';

function audit(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: EVENT,
    actorType: 'admin',
    actorId: 'operator',
    action: 'policy.deleted',
    targetType: 'policy',
    targetId: TARGET,
    result: 'success',
    createdAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

function page(data: AuditEvent[], total = data.length): Page<AuditEvent> {
  return { data, pagination: { page: 1, limit: 20, total, totalPages: total === 0 ? 0 : 1 } };
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  render(await AuditPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  getAudit.mockReset();
});

describe('audit trail page', () => {
  it('renders the empty trail without inventing a record', async () => {
    getAudit.mockResolvedValue(page([]));

    await renderPage();

    expect(screen.getByText('No audit events recorded')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('distinguishes a no-match trail from an empty one', async () => {
    getAudit.mockResolvedValue(page([]));

    await renderPage({ result: 'denied' });

    expect(screen.getByText('No audit events match these filters')).toBeTruthy();
  });

  it('treats a failed read as an error, not an empty trail', async () => {
    getAudit.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    await renderPage();

    expect(screen.getByText('The audit trail could not be read')).toBeTruthy();
    expect(screen.queryByText('No audit events recorded')).toBeNull();
  });

  it('renders actor, action, target and result as words', async () => {
    getAudit.mockResolvedValue(page([audit()]));

    await renderPage();

    // Scoped to the table: the filter selects also contain these words as
    // <option> text.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Operator')).toBeTruthy();
    expect(table.getByText('policy.deleted')).toBeTruthy();
    expect(table.getByText('policy')).toBeTruthy();
    expect(table.getByText(TARGET)).toBeTruthy();
    expect(table.getByText('Success')).toBeTruthy();
    expect(table.getByRole('link', { name: /2026-11-21/ }).getAttribute('href')).toBe(`/dashboard/audit/${EVENT}`);
  });

  it('offers no edit or delete control on any row', async () => {
    getAudit.mockResolvedValue(page([audit()]));

    await renderPage();

    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('forwards the gateway filters and drops an invalid target type', async () => {
    getAudit.mockResolvedValue(page([]));

    await renderPage({ action: 'policy.deleted', actorType: 'agent', targetType: 'operator', order: 'asc' });

    expect(getAudit).toHaveBeenCalledWith({ action: 'policy.deleted', actorType: 'agent', order: 'asc' });
  });

  it('points the export at the same filters', async () => {
    getAudit.mockResolvedValue(page([]));

    await renderPage({ result: 'denied' });

    const link = screen.getByRole('link', { name: 'Export CSV' });
    expect(link.getAttribute('href')).toBe('/api/audit-export?result=denied');
  });

  it('never renders metadata from a list row', async () => {
    // A payload that *did* include metadata must still not be rendered here: the
    // detail page is the disclosure boundary.
    getAudit.mockResolvedValue(page([audit({ metadata: { reason: 'test' } })]));

    const { container } = render(await AuditPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).not.toContain('test');
  });
});
