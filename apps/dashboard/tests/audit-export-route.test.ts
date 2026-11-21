// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit export route handler.
 *
 * Claims pinned here, each a way an export could leak or lie:
 *
 *  * it re-reads with the **parsed** filters, so a hand-crafted parameter cannot
 *    widen the file beyond what the page offers;
 *  * it refuses to invent a body when the gateway fails — the caller gets an
 *    error envelope and no CSV;
 *  * it stops at the documented row cap and reports truncation in a header
 *    instead of silently shipping a partial security record;
 *  * the response is `text/csv` with an attachment filename.
 */

vi.mock('@/lib/auth/guard', () => ({
  operatorCookieHeader: async () => 'umg_operator=token',
  operatorCredentials: async () => ({ cookie: 'umg_operator=token', csrfToken: 'csrf-token' }),
}));

const getAudit = vi.fn();
vi.mock('@/lib/api/endpoints', () => ({ getAudit: (...args: unknown[]) => getAudit(...args) }));

const { GET } = await import('@/app/api/audit-export/route');
const { ApiError } = await import('@/lib/api/errors');

function event(index: number): Record<string, unknown> {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    actorType: 'admin',
    actorId: 'operator',
    action: 'agent.updated',
    targetType: 'agent',
    targetId: '22222222-2222-4222-8222-222222222222',
    result: 'success',
    createdAt: '2026-11-21T00:00:00.000Z',
  };
}

function request(query = ''): Request {
  return new Request(`http://localhost:3000/api/audit-export${query}`);
}

function page(count: number, total: number, pageNumber = 1): Record<string, unknown> {
  return {
    data: Array.from({ length: count }, (_, index) => event((pageNumber - 1) * 100 + index + 1)),
    pagination: { page: pageNumber, limit: 100, total, totalPages: Math.ceil(total / 100) },
  };
}

beforeEach(() => {
  getAudit.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/audit-export', () => {
  it('returns CSV with an attachment filename', async () => {
    getAudit.mockResolvedValue(page(2, 2));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = await response.text();
    expect(body.split('\r\n')[0]).toContain('"actorType"');
    expect(body).toContain('"agent.updated"');
  });

  it('re-reads with the parsed filters only', async () => {
    getAudit.mockResolvedValue(page(1, 1));

    await GET(request('?result=denied&action=policy.deleted&targetType=operator&evil=1&page=7'));

    const call = getAudit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.result).toBe('denied');
    expect(call.action).toBe('policy.deleted');
    // `operator` is not in the list filter enum, and `evil` is not a parameter.
    expect(call.targetType).toBeUndefined();
    expect(call.evil).toBeUndefined();
    expect(call.page).toBe(1);
    expect(call.limit).toBe(100);
  });

  it('reports an unreachable gateway as an error, never as an empty file', async () => {
    getAudit.mockRejectedValue(new ApiError('unavailable', 'Cannot reach the gateway.'));

    const response = await GET(request());

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUDIT_EXPORT_FAILED');
  });

  it('passes a gateway 4xx through instead of masking it as success', async () => {
    getAudit.mockRejectedValue(new ApiError('http', 'Bad filter.', { status: 400, code: 'VALIDATION_ERROR' }));

    const response = await GET(request('?result=nonsense'));

    expect(response.status).toBe(400);
  });

  it('reads every page up to the cap and flags truncation', async () => {
    // 12 pages of 100 = 1200 rows, above the 1000-row cap.
    getAudit.mockImplementation(async (query: { page: number }) => page(100, 1200, query.page));

    const response = await GET(request());

    expect(getAudit).toHaveBeenCalledTimes(10);
    expect(response.headers.get('x-audit-rows')).toBe('1000');
    expect(response.headers.get('x-audit-total')).toBe('1200');
    expect(response.headers.get('x-audit-truncated')).toBe('true');

    const body = await response.text();
    // Header + 1000 rows + trailing newline.
    expect(body.trimEnd().split('\r\n').length).toBe(1001);
  });

  it('does not flag truncation when the whole trail fits', async () => {
    getAudit.mockImplementation(async (query: { page: number }) => page(50, 50, query.page));

    const response = await GET(request());

    expect(response.headers.get('x-audit-rows')).toBe('50');
    expect(response.headers.get('x-audit-truncated')).toBe('false');
  });
});
