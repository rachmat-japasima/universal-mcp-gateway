import { NextResponse } from 'next/server';

import { isApiError } from '@/lib/api/errors';
import { getAudit } from '@/lib/api/endpoints';
import type { AuditEvent } from '@/lib/api/types';
import { auditCsvFilename, EXPORT_PAGE_SIZE, EXPORT_ROW_CAP, toAuditCsv } from '@/lib/events/csv';
import { parseAuditQuery } from '@/lib/events/query';

/**
 * The audit CSV export.
 *
 * A route handler rather than a client-side download: the browser cannot reach
 * the loopback gateway, and building the CSV in the browser would mean shipping
 * the whole audit page to it first. The handler forwards the operator's own
 * cookie, so this is the same authenticated read the page makes — not a second
 * path with its own permissions.
 *
 * The query string is parsed by the same function the page uses, so the export
 * honours exactly the filters on screen and cannot be widened by hand-crafted
 * parameters: anything outside the documented filter set is dropped before the
 * gateway sees it.
 *
 * Bounded by `EXPORT_ROW_CAP`. Reaching the cap is reported in headers
 * (`x-audit-rows`, `x-audit-truncated`, `x-audit-total`) rather than silently
 * truncating a security record.
 */

export const dynamic = 'force-dynamic';

const MAX_EXPORT_PAGES = Math.ceil(EXPORT_ROW_CAP / EXPORT_PAGE_SIZE);

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const query = parseAuditQuery((key) => params[key]);

  const events: AuditEvent[] = [];
  let total = 0;

  try {
    for (let page = 1; page <= MAX_EXPORT_PAGES; page += 1) {
      const read = await getAudit({ ...query, page, limit: EXPORT_PAGE_SIZE, order: query.order ?? 'desc' });
      events.push(...read.data);
      total = read.pagination.total;

      if (read.data.length < EXPORT_PAGE_SIZE || events.length >= EXPORT_ROW_CAP || page >= read.pagination.totalPages) {
        break;
      }
    }
  } catch (error) {
    const status = isApiError(error) && error.status !== undefined ? error.status : 502;
    const message = isApiError(error) ? error.userMessage : 'The audit trail could not be read.';

    return NextResponse.json(
      { error: { code: 'AUDIT_EXPORT_FAILED', message, requestId: 'dashboard-export' } },
      { status },
    );
  }

  const rows = events.slice(0, EXPORT_ROW_CAP);

  return new NextResponse(toAuditCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${auditCsvFilename()}"`,
      'cache-control': 'no-store',
      'x-audit-rows': String(rows.length),
      'x-audit-total': String(total),
      'x-audit-truncated': rows.length < total ? 'true' : 'false',
    },
  });
}
